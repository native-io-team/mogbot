//! The companion on the real desktop: the backend that calls the Agents
//! command functions, the subscription to their events, the Mac's status,
//! `tailscale serve`, and turning it all on and off.

use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Listener};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use super::hub::HubItem;
use super::router::{
    AgentToggles, ApprovalAnswer, Backend, PhoneNewAgent, RoomSend, ScheduleOp, SendExtras,
};
use super::wire::{ClaudeInfo, Event, Known, MacStatus, PowerInfo, Route, RouteKind};
use super::{Companion, Registry, TAILNET_HTTPS_PORT};
use crate::agents::{runner, store};
use crate::commands::agents as cmd;
use crate::errors::CommandError;
use crate::remote_access::{power, tailscale};

/// The Phone panel listens for this and re-reads `companion_status`.
pub const EVENT_CHANGED: &str = "companion://changed";

static COMPANION: OnceLock<Arc<Companion>> = OnceLock::new();

/// The companion, if anything has created it this run.
pub fn get() -> Option<Arc<Companion>> {
    COMPANION.get().cloned()
}

/// Create the companion (once) and subscribe it to the agents' events. The
/// journal starts here, so its epoch is this run's.
pub fn ensure(app: &AppHandle) -> Arc<Companion> {
    COMPANION
        .get_or_init(|| {
            let path = crate::commands::setup::get_app_state_path()
                .parent()
                .map(|dir| dir.join("companion.json"))
                .unwrap_or_else(|| std::path::PathBuf::from("companion.json"));
            let backend = Arc::new(DesktopBackend { app: app.clone() });
            let c = Arc::new(Companion::new(Registry::load(path), backend));
            subscribe(app, &c);
            tauri::async_runtime::spawn(watch_projects(c.clone()));
            c
        })
        .clone()
}

/// `notify::on_screen` for a phone's label.
pub fn is_showing(label: &str) -> bool {
    get().is_some_and(|c| c.label_on_screen(label))
}

// ============================================================================
// Events: the desktop's own, journaled as they are emitted
// ============================================================================

/// The overview is rebuilt at most this often: `agents://registry` fires on
/// every message, and the overview reads every agent.
const REGISTRY_DEBOUNCE: Duration = Duration::from_millis(150);

fn subscribe(app: &AppHandle, c: &Arc<Companion>) {
    let hub = c.clone();
    app.listen_any(runner::EVENT_MESSAGE, move |event| {
        if let Ok(message) = serde_json::from_str::<Value>(event.payload()) {
            hub.hub.publish(Event::Message { message });
        }
    });
    let hub = c.clone();
    app.listen_any(runner::EVENT_STATUS, move |event| {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload {
            agent_id: String,
            status: Value,
        }
        if let Ok(p) = serde_json::from_str::<Payload>(event.payload()) {
            hub.hub.publish(Event::Status {
                agent_id: p.agent_id,
                status: p.status,
            });
        }
    });
    let hub = c.clone();
    app.listen_any(runner::EVENT_DRAFT, move |event| {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload {
            agent_id: String,
            id: String,
            text: String,
        }
        if let Ok(p) = serde_json::from_str::<Payload>(event.payload()) {
            hub.hub.draft(p.agent_id, p.id, p.text);
        }
    });
    // Rooms: the whole list, debounced like the overview (every line said
    // in a room bumps its row).
    let hub = c.clone();
    let pending_rooms = Arc::new(AtomicBool::new(false));
    app.listen_any(crate::agents::rooms::EVENT_ROOMS, move |_| {
        if pending_rooms.swap(true, Ordering::SeqCst) {
            return;
        }
        let (hub, pending) = (hub.clone(), pending_rooms.clone());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(REGISTRY_DEBOUNCE).await;
            pending.store(false, Ordering::SeqCst);
            match hub.backend.rooms().await {
                Ok(rooms) => {
                    hub.hub.publish(Event::Rooms { rooms });
                }
                Err(e) => tracing::warn!("[Companion] Could not read the rooms: {}", e),
            }
        });
    });
    // "Setting up your team" changed: the phone re-reads its card on the
    // registry event it already follows, so the desk's change is one.
    let relay = app.clone();
    app.listen_any(crate::agents::team_setup::EVENT, move |_| {
        let _ = relay.emit(runner::EVENT_REGISTRY, ());
    });
    let hub = c.clone();
    let pending = Arc::new(AtomicBool::new(false));
    app.listen_any(runner::EVENT_REGISTRY, move |_| {
        if pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let (hub, pending) = (hub.clone(), pending.clone());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(REGISTRY_DEBOUNCE).await;
            pending.store(false, Ordering::SeqCst);
            match hub.backend.overview().await {
                Ok(overview) => {
                    hub.hub.publish(Event::Registry { overview });
                }
                Err(e) => tracing::warn!("[Companion] Could not read the overview: {}", e),
            }
        });
    });
}

/// Git (branch, uncommitted count) is asked every this many looks.
const GIT_EVERY: u32 = 5;

/// Journal `projects.changed` / `projects.removed` while a phone is in the
/// foreground (see `companion/projects.rs`). Tabs are read every look (2 s,
/// 4 s on battery: `power::Poll::PhoneProjects`); git every [`GIT_EVERY`]th,
/// its answer reused in between. With no phone in the foreground the loop
/// sleeps a whole look and touches nothing.
async fn watch_projects(c: Arc<Companion>) {
    use crate::remote_access::tools::{project_git, project_name, project_sessions, ProjectView};
    let mut watch = super::projects::ProjectsWatch::default();
    let mut git: std::collections::HashMap<String, (Option<String>, usize)> = Default::default();
    let mut tick: u32 = 0;
    loop {
        if !c.any_foreground() {
            // No timer at all until a phone opens the app.
            c.foreground_changed.notified().await;
            continue;
        }
        tokio::time::sleep(crate::power::every(crate::power::Poll::PhoneProjects)).await;
        if !c.any_foreground() {
            continue;
        }
        let projects = all_projects().await;
        let fresh_git = tick.is_multiple_of(GIT_EVERY);
        tick = tick.wrapping_add(1);
        let mut views = Vec::with_capacity(projects.len());
        for path in &projects {
            if fresh_git || !git.contains_key(path) {
                git.insert(path.clone(), project_git(path).await);
            }
            let (branch, dirty_files) = git.get(path).cloned().unwrap_or_default();
            views.push(ProjectView {
                path: path.clone(),
                name: project_name(path).to_string(),
                branch,
                dirty_files,
                sessions: project_sessions(path),
            });
        }
        git.retain(|p, _| projects.contains(p));
        let views: Vec<Value> = views
            .into_iter()
            .filter_map(|v| serde_json::to_value(v).ok())
            .collect();
        for event in watch.diff(views) {
            c.hub.publish(event);
        }
    }
}

// ============================================================================
// The backend: the Agents commands, called as the desk calls them
// ============================================================================

struct DesktopBackend {
    app: AppHandle,
}

fn json<T: Serialize>(v: T) -> Result<Value, CommandError> {
    serde_json::to_value(v).map_err(|e| CommandError::from(format!("serialize: {e}")))
}

#[async_trait]
impl Backend for DesktopBackend {
    async fn overview(&self) -> Result<Value, CommandError> {
        Ok(super::wire::phone_overview(json(
            cmd::agents_overview(self.app.clone()).await?,
        )?))
    }

    async fn messages(
        &self,
        agent_id: &str,
        limit: usize,
        before: Option<&str>,
    ) -> Result<(Vec<Value>, bool), CommandError> {
        let (agent_id, before) = (agent_id.to_string(), before.map(str::to_string));
        // One past the page says whether older messages exist.
        let (page, more) = tokio::task::spawn_blocking(move || {
            let mut page =
                store::messages_page(&agent_id, limit.saturating_add(1), before.as_deref(), None)?;
            let more = page.len() > limit;
            if more {
                page.drain(..page.len() - limit);
            }
            // What each turn did, read after the log's lock is let go.
            crate::agents::work::apply(&agent_id, &mut page);
            crate::agents::logins::apply(&mut page);
            crate::agents::step_in::apply(&mut page);
            crate::agents::admin::apply(&mut page);
            crate::agents::remember::apply(&agent_id, &mut page);
            Ok::<_, CommandError>((page, more))
        })
        .await
        .map_err(crate::agents::err_other)??;
        Ok((page.into_iter().map(json).collect::<Result<_, _>>()?, more))
    }

    async fn send(
        &self,
        agent_id: &str,
        text: String,
        extras: SendExtras,
    ) -> Result<Value, CommandError> {
        let mentions = (!extras.mentions.is_empty()).then_some(extras.mentions);
        let attachments = (!extras.attachments.is_empty()).then(|| {
            extras
                .attachments
                .into_iter()
                .map(|a| crate::agents::attachments::OutgoingAttachment {
                    name: a.name,
                    path: Some(a.path.display().to_string()),
                    data: None,
                })
                .collect()
        });
        json(
            cmd::agents_send(
                self.app.clone(),
                agent_id.to_string(),
                text,
                attachments,
                mentions,
                extras.client_id,
                extras.revises,
            )
            .await?,
        )
    }

    async fn stop(&self, agent_id: &str) -> Result<bool, CommandError> {
        cmd::agents_stop(self.app.clone(), agent_id.to_string()).await
    }

    async fn interrupt(&self, agent_id: &str) -> Result<bool, CommandError> {
        cmd::agents_interrupt(agent_id.to_string()).await
    }

    async fn stop_step(&self, agent_id: &str) -> Result<String, CommandError> {
        cmd::agents_stop_step(agent_id.to_string()).await
    }

    async fn check_on(&self, agent_id: &str) -> Result<String, CommandError> {
        cmd::agents_check_on(agent_id.to_string()).await
    }

    async fn answer_approval(&self, a: ApprovalAnswer) -> Result<(), CommandError> {
        cmd::agents_answer_approval(
            self.app.clone(),
            a.agent_id,
            a.request_id,
            a.allow,
            a.always,
            a.note,
            a.choice,
        )
        .await
    }

    async fn save_secret(
        &self,
        agent_id: &str,
        request_id: &str,
        values: Vec<String>,
    ) -> Result<Value, CommandError> {
        json(
            cmd::agents_save_secret(
                self.app.clone(),
                agent_id.to_string(),
                request_id.to_string(),
                values,
            )
            .await?,
        )
    }

    async fn memory(&self, agent_id: &str) -> Result<Value, CommandError> {
        json(cmd::agents_memory(agent_id.to_string()).await?)
    }

    async fn memory_change(&self, agent_id: &str, change: Value) -> Result<Value, CommandError> {
        let change = serde_json::from_value(change)
            .map_err(|e| crate::agents::err_invalid("change", e.to_string()))?;
        json(cmd::agents_memory_change(agent_id.to_string(), change).await?)
    }

    async fn memory_suggest(&self, text: String) -> Result<String, CommandError> {
        cmd::agents_memory_suggest(text).await
    }

    async fn focus(&self, label: &str, agent_id: Option<String>) -> Result<(), CommandError> {
        cmd::focus_as(&self.app, label, agent_id)
    }

    async fn rooms(&self) -> Result<Value, CommandError> {
        json(crate::commands::agent_rooms::agents_rooms().await?)
    }

    async fn room_messages(
        &self,
        room_id: &str,
        limit: usize,
        before: Option<&str>,
    ) -> Result<(Vec<Value>, bool), CommandError> {
        let (room_id, before) = (room_id.to_string(), before.map(str::to_string));
        // One past the page says whether older lines exist.
        let (page, more) = tokio::task::spawn_blocking(move || {
            let mut page = crate::agents::rooms::messages_page(
                &room_id,
                limit.saturating_add(1),
                before.as_deref(),
            )?;
            let more = page.len() > limit;
            if more {
                page.drain(..page.len() - limit);
            }
            Ok::<_, CommandError>((page, more))
        })
        .await
        .map_err(crate::agents::err_other)??;
        Ok((page.into_iter().map(json).collect::<Result<_, _>>()?, more))
    }

    async fn room_send(
        &self,
        room_id: &str,
        text: String,
        send: RoomSend,
    ) -> Result<Value, CommandError> {
        json(
            crate::commands::agent_rooms::agents_room_send(
                self.app.clone(),
                room_id.to_string(),
                text,
                Some(send.mentions),
                Some(send.everyone),
                send.client_id,
                None,
            )
            .await?,
        )
    }

    async fn room_focus(&self, label: &str, room_id: Option<String>) -> Result<(), CommandError> {
        crate::commands::agent_rooms::focus_room_as(&self.app, label, room_id)
    }

    async fn mark_unread(&self, agent_id: &str) -> Result<(), CommandError> {
        cmd::agents_mark_unread(self.app.clone(), agent_id.to_string()).await
    }

    async fn start_fresh(&self, agent_id: &str) -> Result<Value, CommandError> {
        json(cmd::agents_start_fresh(self.app.clone(), agent_id.to_string()).await?)
    }

    async fn create_agent(&self, input: PhoneNewAgent) -> Result<Value, CommandError> {
        // No engine and no model: `agents_create` puts it where a desk-made
        // one would start, the user's defaults for new agents (Settings →
        // Agents) when that engine can run, else the first engine that can.
        let color = match input.color {
            Some(c) => c,
            None => {
                let taken: Vec<String> = store::list()?.into_iter().map(|a| a.color).collect();
                super::router::free_color(&taken).to_string()
            }
        };
        // A ready-made agent brings its briefing; the role is what the phone sent.
        let template = input
            .template
            .as_deref()
            .and_then(crate::agents::templates::find);
        let input = cmd::CreateAgentInput {
            name: input.name,
            shape: None,
            avatar: input.avatar,
            color: Some(color),
            role: input.role,
            // What the user reviewed after a draft, else the template's briefing.
            instructions: match input.instructions {
                Some(text) => text,
                None => template.map(|t| t.instructions()).unwrap_or_default(),
            },
            engine: None,
            model: None,
            project: None,
            template: template.map(|t| t.id.clone()),
            routines: input.routines,
        };
        // Read before, as `agents_create` reads it, so its first line can say
        // where it went and, on a fallback, why: the header's badge leaves
        // Claude Code unsaid.
        let defaults = crate::agents::defaults::view().await;
        let agent = cmd::agents_create(self.app.clone(), input).await?;
        let note = runner::new_message(
            &agent.id,
            store::MessageKind::Note,
            phone_created_line(&defaults.started_on(agent.engine, false)),
        );
        let _ = runner::record(&self.app, note);
        json(agent)
    }

    async fn draft_agent(&self, description: String) -> Result<Value, CommandError> {
        json(cmd::agents_draft(description).await?)
    }

    async fn update_agent(
        &self,
        agent_id: &str,
        toggles: AgentToggles,
    ) -> Result<Value, CommandError> {
        let input = cmd::UpdateAgentInput {
            name: None,
            shape: None,
            avatar: toggles.avatar,
            color: toggles.color.map(|c| c.trim().to_string()),
            role: None,
            instructions: toggles.instructions,
            pinned: toggles.pinned,
            hidden: toggles.hidden,
            muted: toggles.muted,
            engine: toggles.engine,
            model: toggles.model,
            routine_model: None,
            effort: toggles.effort,
            project: None,
            work_directly: None,
            account: toggles.account,
        };
        json(cmd::agents_update(self.app.clone(), agent_id.to_string(), input).await?)
    }

    async fn files(&self, agent_id: &str) -> Result<Value, CommandError> {
        json(cmd::agents_files(agent_id.to_string()).await?)
    }

    async fn instructions(&self, agent_id: &str) -> Result<String, CommandError> {
        cmd::agents_instructions(agent_id.to_string()).await
    }

    async fn usage(&self, agent_id: &str) -> Result<Value, CommandError> {
        json(cmd::agents_usage(agent_id.to_string()).await?)
    }

    async fn quota(&self) -> Result<Value, CommandError> {
        json(cmd::agents_quota().await?)
    }

    async fn set_defaults(
        &self,
        change: crate::agents::defaults::Change,
    ) -> Result<Value, CommandError> {
        json(cmd::agents_set_defaults(self.app.clone(), change).await?)
    }

    async fn set_independence(
        &self,
        level: crate::agents::independence::Level,
    ) -> Result<Value, CommandError> {
        let level = serde_json::to_value(level).map_err(crate::agents::err_other)?;
        let level = level.as_str().unwrap_or_default().to_string();
        let level = cmd::agents_set_independence(self.app.clone(), level).await?;
        Ok(serde_json::json!({ "level": level }))
    }

    async fn set_import_choice(
        &self,
        choice: crate::agents::import_choice::Choice,
    ) -> Result<Value, CommandError> {
        let choice = serde_json::to_value(choice).map_err(crate::agents::err_other)?;
        let choice = choice.as_str().unwrap_or_default().to_string();
        let choice = cmd::agents_set_import_choice(self.app.clone(), choice).await?;
        Ok(serde_json::json!({ "choice": choice }))
    }

    async fn set_admin(&self, agent_id: &str, admin: bool) -> Result<Value, CommandError> {
        let agent = cmd::agents_set_admin(self.app.clone(), agent_id.to_string(), admin).await?;
        Ok(serde_json::json!({
            "agentId": agent.id,
            "admin": crate::agents::admin::is_admin(&agent),
        }))
    }

    async fn set_agent_independence(
        &self,
        agent_id: &str,
        level: Option<crate::agents::independence::Level>,
    ) -> Result<Value, CommandError> {
        let word = match level {
            Some(l) => serde_json::to_value(l)
                .map_err(crate::agents::err_other)?
                .as_str()
                .unwrap_or_default()
                .to_string(),
            None => "team".to_string(),
        };
        // The agent must exist: `policy::set` would keep a stranger's id.
        crate::agents::store::get(agent_id)?;
        cmd::agents_policy_set(
            self.app.clone(),
            crate::agents::policy::Target::Agent {
                agent_id: agent_id.to_string(),
            },
            crate::agents::policy::Change {
                independence: Some(word),
                ..Default::default()
            },
        )
        .await?;
        let own = crate::agents::policy::own_independence(&crate::agents::policy::load(), agent_id);
        Ok(serde_json::json!({ "agentId": agent_id, "level": own }))
    }

    async fn accounts(&self) -> Result<Value, CommandError> {
        json(cmd::agents_accounts().await?)
    }

    async fn account_use(&self, engine: &str, id: &str) -> Result<Value, CommandError> {
        json(cmd::agents_account_use(self.app.clone(), engine.to_string(), id.to_string()).await?)
    }

    async fn account_reorder(&self, engine: &str, ids: Vec<String>) -> Result<Value, CommandError> {
        cmd::agents_account_reorder(self.app.clone(), engine.to_string(), ids).await?;
        json(cmd::agents_accounts().await?)
    }

    async fn usage_plan(&self) -> Result<Value, CommandError> {
        json(crate::commands::agents_usage::agents_usage_overview(self.app.clone(), None).await?)
    }

    async fn import_status(&self) -> Result<Value, CommandError> {
        import_status_now().await
    }

    async fn import_start(&self) -> Result<Value, CommandError> {
        crate::agents::connector::arm(&self.app)?;
        import_status_now().await
    }

    async fn import_stop(&self) -> Result<Value, CommandError> {
        crate::agents::connector::stop(&self.app);
        import_status_now().await
    }

    async fn import_review(
        &self,
        agent_id: &str,
        request_id: &str,
        keys: Vec<String>,
        notes: bool,
    ) -> Result<Value, CommandError> {
        let app = self.app.clone();
        let (agent_id, request_id) = (agent_id.to_string(), request_id.to_string());
        let picks = crate::agents::review::Picks {
            agents: keys
                .into_iter()
                .map(|key| crate::agents::review::Pick {
                    key,
                    ..Default::default()
                })
                .collect(),
            chief_notes: notes,
        };
        let applied = tauri::async_runtime::spawn_blocking(move || {
            crate::agents::connector::apply_review(&app, &agent_id, &request_id, &picks)
        })
        .await
        .map_err(crate::agents::err_other)??;
        json(applied)
    }

    async fn login_start(
        &self,
        agent_id: &str,
        request_id: &str,
        option_id: &str,
        on_phone: bool,
    ) -> Result<(), CommandError> {
        cmd::agents_login_start(
            self.app.clone(),
            agent_id.to_string(),
            request_id.to_string(),
            option_id.to_string(),
            Some(true),
            Some(on_phone),
        )
        .await
    }

    async fn login_phone_begin(
        &self,
        device_id: &str,
        target: crate::agents::login_relay::Target,
        option_id: &str,
    ) -> Result<Value, CommandError> {
        json(crate::agents::login_relay::begin(&self.app, device_id, target, option_id).await?)
    }

    async fn phone_signin(
        &self,
        device_id: &str,
        device_name: &str,
        op: crate::agents::phone_signin::Op,
    ) -> Result<Value, CommandError> {
        crate::agents::phone_signin::run(&self.app, device_id, device_name, op).await
    }

    async fn login_phone_finish(
        &self,
        device_id: &str,
        flow_id: &str,
        callback: &str,
    ) -> Result<(), CommandError> {
        crate::agents::login_relay::finish(device_id, flow_id, callback).await
    }

    async fn login_cancel(&self, agent_id: &str, request_id: &str) -> Result<(), CommandError> {
        cmd::agents_login_cancel(
            self.app.clone(),
            agent_id.to_string(),
            request_id.to_string(),
        )
        .await
    }

    async fn login_decline(
        &self,
        agent_id: &str,
        request_id: &str,
        note: Option<String>,
    ) -> Result<(), CommandError> {
        cmd::agents_login_decline(
            self.app.clone(),
            agent_id.to_string(),
            request_id.to_string(),
            note,
        )
        .await
    }

    async fn login_save_key(
        &self,
        agent_id: &str,
        request_id: &str,
        value: String,
    ) -> Result<Value, CommandError> {
        json(
            cmd::agents_login_save_key(
                self.app.clone(),
                agent_id.to_string(),
                request_id.to_string(),
                value,
            )
            .await?,
        )
    }

    async fn reach(&self, agent_id: &str) -> Result<Value, CommandError> {
        json(cmd::agents_reach(agent_id.to_string()).await?)
    }

    async fn policy(&self, agent_id: &str) -> Result<Value, CommandError> {
        json(cmd::agents_policy(agent_id.to_string()).await?)
    }

    async fn logins_team(&self, since: Option<i64>) -> Result<Value, CommandError> {
        json(cmd::agents_logins_team(since).await?)
    }

    async fn logins_connect(
        &self,
        key: &str,
        option_id: &str,
        skip: Vec<String>,
        on_phone: bool,
    ) -> Result<(), CommandError> {
        cmd::agents_logins_connect(
            self.app.clone(),
            key.to_string(),
            option_id.to_string(),
            Some(skip),
            Some(true),
            Some(on_phone),
        )
        .await
    }

    async fn login_dismiss(&self, agent_id: &str, request_id: &str) -> Result<(), CommandError> {
        cmd::agents_login_dismiss(
            self.app.clone(),
            agent_id.to_string(),
            request_id.to_string(),
        )
        .await
    }

    async fn login_not_needed(
        &self,
        agent_id: &str,
        request_id: &str,
    ) -> Result<Value, CommandError> {
        json(
            cmd::agents_login_not_needed(
                self.app.clone(),
                agent_id.to_string(),
                request_id.to_string(),
            )
            .await?,
        )
    }

    async fn logins_not_needed(&self, keys: Option<Vec<String>>) -> Result<Value, CommandError> {
        json(cmd::agents_logins_not_needed(self.app.clone(), keys).await?)
    }

    async fn logins_undecline(&self, keys: Vec<String>) -> Result<Value, CommandError> {
        json(cmd::agents_logins_undecline(self.app.clone(), keys).await?)
    }

    async fn logins_recheck(&self) -> Result<(), CommandError> {
        cmd::agents_logins_recheck().await
    }

    async fn apps(&self) -> Result<Value, CommandError> {
        let view = tokio::task::spawn_blocking(crate::agents::app_connect::phone_overview)
            .await
            .map_err(crate::agents::err_other)??;
        json(view)
    }

    async fn apps_connect(
        &self,
        service: &str,
        grants: Vec<crate::agents::app_connect::GrantInput>,
        again: Option<String>,
    ) -> Result<(), CommandError> {
        cmd::agents_app_connect(self.app.clone(), service.to_string(), grants, again).await
    }

    async fn apps_phone_begin(
        &self,
        device_id: &str,
        service: &str,
        grants: Vec<crate::agents::app_connect::GrantInput>,
        again: Option<String>,
    ) -> Result<Value, CommandError> {
        json(
            crate::agents::app_connect::phone_begin(
                &self.app,
                device_id,
                service,
                &grants,
                again.as_deref(),
            )
            .await?,
        )
    }

    async fn apps_cancel(&self, service: &str) -> Result<(), CommandError> {
        cmd::agents_app_connect_cancel(self.app.clone(), service.to_string()).await
    }

    async fn apps_set_grants(
        &self,
        connection_id: &str,
        grants: Vec<crate::agents::app_connect::GrantInput>,
    ) -> Result<Value, CommandError> {
        let c = cmd::agents_connection_set_grants(connection_id.to_string(), grants).await?;
        json(crate::agents::app_connect::phone_connection(&c))
    }

    async fn apps_remove(&self, connection_id: &str) -> Result<(), CommandError> {
        cmd::agents_connection_delete(self.app.clone(), connection_id.to_string()).await
    }

    async fn team_setup(
        &self,
        action: super::router::TeamSetupAction,
    ) -> Result<Value, CommandError> {
        use super::router::TeamSetupAction as A;
        let app = self.app.clone();
        match action {
            A::Get { any } => json(cmd::agents_team_setup(Some(any)).await?),
            A::Step { step, state } => {
                cmd::agents_team_setup_step(app, step, state).await?;
                Ok(Value::Null)
            }
            A::Routine {
                agent_id,
                check_in_id,
                on,
            } => {
                cmd::agents_team_setup_routine(app, agent_id, check_in_id, on).await?;
                Ok(Value::Null)
            }
            A::Hello { agent_id } => json(cmd::agents_team_setup_hello(app, agent_id).await?),
            A::Missing => json(cmd::agents_team_setup_missing(app).await?),
            A::Dismiss => {
                cmd::agents_team_setup_dismiss(app).await?;
                Ok(Value::Null)
            }
            A::Later {
                key,
                connect,
                on_phone,
            } => json(
                cmd::agents_team_setup_later(
                    app,
                    key,
                    if connect { "connect" } else { "not_needed" }.into(),
                    Some(true),
                    Some(on_phone),
                )
                .await?,
            ),
            A::Check => json(cmd::agents_access_check(app).await?),
        }
    }

    async fn revoke_permission(&self, agent_id: &str, rule_id: &str) -> Result<(), CommandError> {
        cmd::agents_revoke_permission(self.app.clone(), agent_id.to_string(), rule_id.to_string())
            .await
    }

    async fn change_diff(
        &self,
        agent_id: &str,
        message_id: &str,
        path: &str,
    ) -> Result<Value, CommandError> {
        json(
            cmd::agents_change_diff(
                agent_id.to_string(),
                message_id.to_string(),
                path.to_string(),
            )
            .await?,
        )
    }

    async fn keep_copy(
        &self,
        agent_id: &str,
        copy_id: &str,
        into: Option<&str>,
    ) -> Result<Value, CommandError> {
        json(
            cmd::agents_copy_keep(
                self.app.clone(),
                agent_id.to_string(),
                Some(copy_id.to_string()),
                into.map(str::to_string),
            )
            .await?,
        )
    }

    async fn discard_copy(&self, agent_id: &str, copy_id: &str) -> Result<(), CommandError> {
        cmd::agents_copy_discard(
            self.app.clone(),
            agent_id.to_string(),
            Some(copy_id.to_string()),
        )
        .await
    }

    async fn shareable_path(
        &self,
        agent_id: &str,
        path: &str,
    ) -> Result<std::path::PathBuf, CommandError> {
        let home = store::agent_home(agent_id)?;
        let mut roots = vec![home.clone()];
        if let Ok(projects) = crate::commands::projects::list_projects().await {
            roots.extend(
                projects
                    .into_iter()
                    .map(|p| std::path::PathBuf::from(p.path)),
            );
        }
        let path = path.to_string();
        tokio::task::spawn_blocking(move || {
            crate::agents::files::shareable(&path, &home, &roots).map_err(CommandError::expected)
        })
        .await
        .map_err(crate::agents::err_other)?
    }

    async fn search(&self, query: String) -> Result<Value, CommandError> {
        json(cmd::agents_search(query).await?)
    }

    async fn schedule(&self, op: ScheduleOp) -> Result<Value, CommandError> {
        let app = self.app.clone();
        // The phone shows "When…" routines read-only: whatever it sends for
        // one (Pause, Cancel, Run now, an edit) is refused here, not only
        // hidden there.
        if let Some((agent_id, id)) = op.target() {
            refuse_watch_from_phone(agent_id, id)?;
        }
        match op {
            ScheduleOp::Preview { when } => json(cmd::agents_schedule_preview(when).await?),
            ScheduleOp::Create {
                agent_id,
                when,
                note,
                then,
            } => json(cmd::agents_schedule_create(app, agent_id, when, note, then).await?),
            ScheduleOp::Update {
                agent_id,
                id,
                when,
                note,
                then,
            } => json(cmd::agents_schedule_update(app, agent_id, id, when, note, then).await?),
            ScheduleOp::Pause {
                agent_id,
                id,
                paused,
            } => json(cmd::agents_schedule_pause(app, agent_id, id, paused).await?),
            ScheduleOp::Cancel { agent_id, id } => {
                json(cmd::agents_schedule_cancel(app, agent_id, id).await?)
            }
            ScheduleOp::RunNow { agent_id, id } => {
                json(cmd::agents_schedule_run_now(app, agent_id, id).await?)
            }
        }
    }

    async fn projects(&self) -> Result<Value, CommandError> {
        json(crate::remote_access::tools::project_views(&all_projects().await).await)
    }

    async fn session_screen(&self, session_id: &str) -> Result<Value, CommandError> {
        let projects = all_projects().await;
        json(
            crate::remote_access::tools::session_screen(&projects, session_id)
                .map_err(CommandError::expected)?,
        )
    }

    async fn session_send(
        &self,
        project: &str,
        session_id: Option<&str>,
        text: &str,
    ) -> Result<String, CommandError> {
        use crate::remote_access::tools::{deliver, resolve_project, Undelivered};
        let project = resolve_project(&all_projects().await, Some(project))
            .map_err(CommandError::expected)?;
        match deliver(&project, session_id, text).await {
            Ok((_, tab, _)) => Ok(tab.session_id),
            Err(Undelivered::Asking { question, .. }) => Err(CommandError::expected(format!(
                "Not sent: it’s waiting for your answer to “{question}”. Answer that first, then send."
            ))),
            Err(Undelivered::NotAsking { .. }) => Err(CommandError::expected("Not sent.")),
            Err(Undelivered::Other(e)) => Err(CommandError::expected(e)),
        }
    }

    async fn session_key(&self, session_id: &str, key: &str) -> Result<(), CommandError> {
        use crate::remote_access::tools::{press, project_of_session, Undelivered};
        let project = project_of_session(&all_projects().await, session_id).ok_or_else(|| {
            CommandError::expected("That session isn't open in the app any more.")
        })?;
        match press(&project, Some(session_id), key) {
            Ok(_) => Ok(()),
            Err(Undelivered::NotAsking { .. }) => Err(CommandError::expected(
                "Not pressed: it isn’t asking anything right now.",
            )),
            Err(Undelivered::Asking { .. }) => Err(CommandError::expected("Not pressed.")),
            Err(Undelivered::Other(e)) => Err(CommandError::expected(e)),
        }
    }

    async fn session_start(&self, project: &str, prompt: &str) -> Result<String, CommandError> {
        use crate::remote_access::tools::{not_a_flag, resolve_project, start_agent_with};
        let project = resolve_project(&all_projects().await, Some(project))
            .map_err(CommandError::expected)?;
        start_agent_with(&self.app, &project, &not_a_flag(prompt))
            .await
            .map(|(_, session_id)| session_id)
            .map_err(CommandError::expected)
    }

    async fn watch_port(
        &self,
        agent_id: &str,
        message_id: &str,
        link: Option<usize>,
    ) -> Result<(String, u16), CommandError> {
        let target =
            crate::commands::agents_preview::target_for(agent_id, message_id, link).await?;
        // A preview's own server, or one an agent's turn left running there.
        let port = crate::proxy::dev_server_port_for(&target.path)
            .or(target
                .port
                .filter(|p| crate::agents::dev_servers::serves(&target.path, *p)))
            .ok_or_else(|| {
                CommandError::expected(
                    "Open Preview on the Mac first — the site isn't running there.",
                )
            })?;
        Ok((target.path, port))
    }

    async fn watch_publish(&self) -> Result<String, CommandError> {
        publish_watch(ensure(&self.app)).await
    }

    async fn preview_screenshot(
        &self,
        project: &str,
        phone: bool,
    ) -> Result<Vec<u8>, CommandError> {
        use crate::remote_access::{shots::Device, tools};
        let project = tools::resolve_project(&all_projects().await, Some(project))
            .map_err(CommandError::expected)?;
        let device = if phone {
            Device::Phone
        } else {
            Device::Desktop
        };
        tools::capture_encoded(&self.app, &project, device, false, None)
            .await
            .map(|e| e.full)
            .map_err(CommandError::expected)
    }

    fn attachment_file(
        &self,
        agent_id: &str,
        rel: &str,
    ) -> Result<std::path::PathBuf, CommandError> {
        crate::agents::attachments::resolve(&store::agent_home(agent_id)?, rel)
    }

    async fn mac_status(&self) -> MacStatus {
        let power_status = power::read_power().await;
        let on_battery = match (power_status.has_battery, power_status.on_ac) {
            (_, Some(ac)) => Known::from(Some(!ac)),
            // No battery at all: it can't be running on one.
            (false, None) => Known::No,
            (true, None) => Known::Unknown,
        };
        MacStatus {
            name: self.server_name(),
            app_version: self.app_version(),
            power: PowerInfo {
                keep_awake: power::keep_awake_active(),
                lid_closed_mode: Known::from(power::lid_closed_mode_active().await),
                on_battery,
                battery_percent: power_status.battery_percent,
            },
            claude: claude_info().await,
            routes: routes(),
        }
    }

    fn server_name(&self) -> String {
        computer_name()
    }

    fn serve_hosts(&self) -> Vec<String> {
        routes()
            .iter()
            .filter(|r| r.kind == RouteKind::Tailscale)
            .filter_map(|r| super::identity::host_of(&r.url))
            .collect()
    }

    fn app_version(&self) -> String {
        self.app.package_info().version.to_string()
    }

    fn audit(&self, actor: &str, tool: &str, detail: String, ok: bool) {
        crate::remote_access::companion_audit(actor, tool, detail, ok);
    }

    fn changed(&self) {
        let _ = self.app.emit(EVENT_CHANGED, ());
    }
}

/// Every Ship Studio project: what agents reach (the P1 decision), and so
/// what the phone sees.
/// What the phone's Import screen shows (`agents.import.status`).
async fn import_status_now() -> Result<Value, CommandError> {
    let remote = crate::commands::remote_access::get_remote_access_status().await?;
    let gate = crate::agents::connector::gate();
    let chief = crate::agents::store::list()?
        .into_iter()
        .find(|a| a.is_main);
    let prompt = crate::agents::import::import_prompt(
        chief.as_ref().map_or("Chief of Staff", |c| c.name.as_str()),
    );
    Ok(serde_json::json!({
        "remoteAccess": {
            "enabled": remote.enabled,
            "funnelOn": remote.funnel_on,
            "everConnected": remote.ever_connected,
        },
        "armed": gate.armed,
        "talk": gate.talk,
        "prompt": prompt,
        "chiefId": chief.map(|c| c.id),
    }))
}

async fn all_projects() -> Vec<String> {
    crate::commands::projects::list_projects()
        .await
        .map(|list| list.into_iter().map(|p| p.path).collect())
        .unwrap_or_default()
}

static COMPUTER_NAME: OnceLock<String> = OnceLock::new();

/// The Mac's name as System Settings shows it. Read once by
/// [`read_computer_name`] when the companion comes up; until then, a plain
/// "this Mac" rather than a guess.
fn computer_name() -> String {
    COMPUTER_NAME
        .get()
        .cloned()
        .unwrap_or_else(|| "this Mac".to_string())
}

async fn read_computer_name() {
    if COMPUTER_NAME.get().is_some() {
        return;
    }
    let mut cmd = tokio::process::Command::new("/usr/sbin/scutil");
    cmd.args(["--get", "ComputerName"]);
    let name = crate::external_command::run_with_timeout(cmd, "scutil", 5)
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|n| !n.is_empty());
    if let Some(name) = name {
        let _ = COMPUTER_NAME.set(name);
    }
}

/// Claude Code installed, its version, and signed in, from the same check
/// onboarding uses. Cached a minute: it spawns processes.
async fn claude_info() -> ClaudeInfo {
    static CACHE: LazyLock<Mutex<Option<(ClaudeInfo, Instant)>>> =
        LazyLock::new(|| Mutex::new(None));
    if let Some((info, at)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        if at.elapsed() < Duration::from_secs(60) {
            return info;
        }
    }
    let bin = tokio::task::spawn_blocking(|| {
        crate::commands::claude::find_validated_binary("claude", "--version")
    })
    .await
    .ok()
    .flatten();
    let info = match bin {
        None => ClaudeInfo {
            installed: false,
            signed_in: Known::Unknown,
            version: None,
        },
        Some(bin) => {
            let mut cmd = tokio::process::Command::new(bin);
            cmd.arg("--version");
            let version = crate::external_command::run_with_timeout(cmd, "claude --version", 10)
                .await
                .ok()
                .and_then(|o| {
                    String::from_utf8_lossy(&o.stdout)
                        .split_whitespace()
                        .next()
                        .map(str::to_string)
                });
            let account = crate::commands::accounts::get_active_account_id()
                .unwrap_or_else(|_| crate::commands::accounts::DEFAULT_ACCOUNT_ID.to_string());
            let signed_in = crate::commands::setup::claude_auth_truth(&account).await;
            ClaudeInfo {
                installed: true,
                signed_in: Known::from(Some(signed_in)),
                version,
            }
        }
    };
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((info.clone(), Instant::now()));
    info
}

// ============================================================================
// Tailscale serve and the lifecycle
// ============================================================================

/// Where the tailnet route stands, as read back from Tailscale.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state"
)]
pub enum ServeState {
    #[default]
    Off,
    /// Served on the tailnet at `url`.
    On {
        url: String,
    },
    /// HTTPS certificates are off on the tailnet; the owner turns them on here.
    NeedsApproval {
        url: String,
    },
    Failed {
        detail: String,
    },
}

struct Running {
    port: u16,
    shutdown: Option<oneshot::Sender<()>>,
}

static RUNNING: LazyLock<Mutex<Option<Running>>> = LazyLock::new(|| Mutex::new(None));
static SERVE: LazyLock<Mutex<ServeState>> = LazyLock::new(|| Mutex::new(ServeState::Off));

pub fn running_port() -> Option<u16> {
    RUNNING.lock().ok().and_then(|r| r.as_ref().map(|r| r.port))
}

pub fn serve_state() -> ServeState {
    SERVE.lock().map(|s| s.clone()).unwrap_or_default()
}

fn set_serve(state: ServeState) {
    if let Ok(mut s) = SERVE.lock() {
        *s = state;
    }
}

/// The routes a phone can use right now. Only a serve handler we read back
/// counts; a command that exited zero proves nothing.
pub fn routes() -> Vec<Route> {
    match serve_state() {
        ServeState::On { url } => vec![Route {
            kind: RouteKind::Tailscale,
            url,
            pin: None,
        }],
        _ => Vec::new(),
    }
}

/// Start the loopback server (idempotent) on last time's port if it's free.
async fn start_server(c: Arc<Companion>) -> Result<u16, CommandError> {
    if let Some(port) = running_port() {
        return Ok(port);
    }
    let stored = c.registry.read(|s| s.port);
    let mut listener = None;
    if let Some(port) = stored {
        listener = TcpListener::bind(("127.0.0.1", port)).await.ok();
    }
    let listener = match listener {
        Some(l) => l,
        None => TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("Could not open a port for the phone: {e}"))?,
    };
    let port = listener
        .local_addr()
        .map_err(|e| format!("companion address: {e}"))?
        .port();
    if stored != Some(port) {
        c.registry.write(|s| s.port = Some(port))?;
    }
    let (tx, rx) = oneshot::channel();
    tauri::async_runtime::spawn(super::server::serve(c, listener, rx));
    tracing::info!("[Companion] listening on 127.0.0.1:{}", port);
    if let Ok(mut r) = RUNNING.lock() {
        *r = Some(Running {
            port,
            shutdown: Some(tx),
        });
    }
    Ok(port)
}

/// Publish the server on the tailnet. Each outcome is kept for the panel.
async fn publish(port: u16) {
    let state = match tailscale::status().await {
        tailscale::TailscaleState::Connected { dns_name, .. } => {
            match tailscale::enable_serve(TAILNET_HTTPS_PORT, port, &dns_name).await {
                tailscale::FunnelOutcome::On => ServeState::On {
                    url: format!("https://{dns_name}:{TAILNET_HTTPS_PORT}"),
                },
                tailscale::FunnelOutcome::NeedsApproval { url } => {
                    ServeState::NeedsApproval { url }
                }
                tailscale::FunnelOutcome::Failed { detail } => ServeState::Failed { detail },
            }
        }
        tailscale::TailscaleState::NotInstalled => ServeState::Failed {
            detail: "Tailscale isn't installed.".into(),
        },
        tailscale::TailscaleState::NeedsLogin => ServeState::Failed {
            detail: "Sign in to Tailscale first.".into(),
        },
        tailscale::TailscaleState::Unknown { detail } => ServeState::Failed { detail },
    };
    set_serve(state);
}

pub async fn bring_up(app: &AppHandle) -> Result<(), CommandError> {
    let c = ensure(app);
    read_computer_name().await;
    let port = start_server(c.clone()).await?;
    publish(port).await;
    c.backend.changed();
    Ok(())
}

/// The watch proxy, once a phone has asked for it: the tailnet URL it's
/// served on, and how to stop it.
struct WatchRunning {
    url: String,
    shutdown: Option<oneshot::Sender<()>>,
}

static WATCH: LazyLock<tokio::sync::Mutex<Option<WatchRunning>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(None));

/// Start the watch proxy on loopback and serve it on the tailnet (`tailscale
/// serve`, never Funnel), once; later calls reuse it.
async fn publish_watch(c: Arc<Companion>) -> Result<String, CommandError> {
    use super::watch::WATCH_TAILNET_PORT;
    let mut slot = WATCH.lock().await;
    if let Some(running) = slot.as_ref() {
        return Ok(running.url.clone());
    }
    let tailscale::TailscaleState::Connected { dns_name, .. } = tailscale::status().await else {
        return Err(CommandError::expected(
            "Tailscale isn't connected on the Mac, so the site can't be shown on the phone.",
        ));
    };
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| CommandError::from(format!("Could not open a port to watch from: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| CommandError::from(format!("watch address: {e}")))?
        .port();
    let (tx, rx) = oneshot::channel();
    tauri::async_runtime::spawn(super::watch::serve(c, listener, rx));
    let refused = match tailscale::enable_serve(WATCH_TAILNET_PORT, port, &dns_name).await {
        tailscale::FunnelOutcome::On => None,
        tailscale::FunnelOutcome::NeedsApproval { .. } => Some(
            "Turn on HTTPS certificates for your tailnet first, as for the phone itself."
                .to_string(),
        ),
        tailscale::FunnelOutcome::Failed { detail } => {
            Some(format!("Tailscale couldn't serve it: {detail}"))
        }
    };
    if let Some(why) = refused {
        let _ = tx.send(());
        return Err(CommandError::expected(why));
    }
    let url = format!("https://{dns_name}:{WATCH_TAILNET_PORT}");
    tracing::info!("[Companion] watch proxy on 127.0.0.1:{} at {}", port, url);
    *slot = Some(WatchRunning {
        url: url.clone(),
        shutdown: Some(tx),
    });
    Ok(url)
}

/// Stop the watch proxy and take it off the tailnet.
async fn stop_watch() {
    let running = WATCH.lock().await.take();
    if let Some(mut running) = running {
        if let Some(tx) = running.shutdown.take() {
            let _ = tx.send(());
        }
        if tailscale::find_binary().is_some() {
            if let Err(e) = tailscale::disable_serve(super::watch::WATCH_TAILNET_PORT).await {
                tracing::warn!("[Companion] {}", e);
            }
        }
    }
}

pub async fn tear_down(app: &AppHandle) {
    let c = ensure(app);
    c.pairing.cancel();
    stop_watch().await;
    if tailscale::find_binary().is_some() {
        if let Err(e) = tailscale::disable_serve(TAILNET_HTTPS_PORT).await {
            tracing::warn!("[Companion] {}", e);
        }
    }
    set_serve(ServeState::Off);
    if let Some(mut running) = RUNNING.lock().ok().and_then(|mut r| r.take()) {
        if let Some(tx) = running.shutdown.take() {
            let _ = tx.send(());
        }
    }
    c.hub.signal(HubItem::Shutdown);
    c.backend.changed();
}

/// Turn the companion on or off. Paired devices are kept either way.
pub async fn set_enabled(app: &AppHandle, enabled: bool) -> Result<(), CommandError> {
    ensure(app).registry.write(|s| s.enabled = enabled)?;
    if enabled {
        bring_up(app).await
    } else {
        tear_down(app).await;
        Ok(())
    }
}

/// Ask Tailscale again (after the user switched HTTPS certificates on).
pub async fn retry_publish(app: &AppHandle) -> Result<(), CommandError> {
    let port =
        running_port().ok_or_else(|| CommandError::expected("The phone server isn't on."))?;
    publish(port).await;
    ensure(app).backend.changed();
    Ok(())
}

/// At launch: if the user left it on, put it back.
pub async fn resume_on_launch(app: AppHandle) {
    let c = ensure(&app);
    if !c.registry.read(|s| s.enabled) {
        return;
    }
    if let Err(e) = bring_up(&app).await {
        tracing::error!("[Companion] Could not resume at launch: {}", e);
    }
}

/// A "When…" routine can't be changed from the phone (see `schedule`).
pub(crate) fn refuse_watch_from_phone(agent_id: &str, id: &str) -> Result<(), CommandError> {
    let is_watch = crate::agents::store::get(agent_id)
        .ok()
        .and_then(|a| a.check_ins.into_iter().find(|c| c.id == id))
        .is_some_and(|c| c.watch.is_some());
    if is_watch {
        return Err(CommandError::expected(
            "“When…” routines can be changed on the Mac only.",
        ));
    }
    Ok(())
}

/// A phone-made agent's first line: "Created on your phone on Claude Code —
/// Codex isn't signed in" (`on` from `View::started_on`).
fn phone_created_line(on: &str) -> String {
    format!("Created on your phone {on}")
}

#[cfg(test)]
mod created_line_tests {
    use super::*;
    use crate::agents::defaults::{view_of, Saved};
    use crate::agents::engine::{Engine, EngineInfo};

    fn info(id: Engine, ready: bool) -> EngineInfo {
        EngineInfo {
            id,
            label: id.label(),
            installed: true,
            signed_in: ready,
            asks: true,
            models: Vec::new(),
        }
    }

    #[test]
    fn a_phone_made_agent_says_its_engine_and_why_on_a_fallback() {
        let saved = Saved {
            engine: Some(Engine::Codex),
            ..Saved::default()
        };
        let engines = [info(Engine::Claude, true), info(Engine::Codex, false)];
        let view = view_of(&saved, &engines);
        assert_eq!(
            phone_created_line(&view.started_on(Engine::Claude, false)),
            "Created on your phone on Claude Code — Codex isn't signed in"
        );
        let engines = [info(Engine::Claude, true), info(Engine::Codex, true)];
        let view = view_of(&saved, &engines);
        assert_eq!(
            phone_created_line(&view.started_on(Engine::Codex, false)),
            "Created on your phone on Codex"
        );
    }
}
