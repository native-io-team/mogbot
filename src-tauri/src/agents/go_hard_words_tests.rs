//! Quoted text that is only text, and variables a line sets itself (names
//! fictional): the shapes that raised cards at "Full send" on 2026-11-08.

use super::*;
use crate::agents::autoallow::auto;
use crate::agents::independence::Level;
use crate::agents::outward::command_sends;
use serde_json::json;

const HOME: &str = "/Users/fictional-tester";

fn ctx() -> Ctx {
    let app = format!("{HOME}/Library/Application Support/FictionalApp");
    let own = format!("{app}/agents/a1");
    Ctx {
        home: HOME.into(),
        own_home: own.clone().into(),
        cwd: own.clone().into(),
        scratch: vec![own.into()],
        app_data: vec![app.into()],
        ..Default::default()
    }
}

fn bash(command: &str) -> Value {
    json!({ "command": command, "description": "x" })
}

fn card_at(level: Level, command: &str) -> bool {
    auto(level, false, "Bash", &bash(command), &ctx()).is_none()
}

/// A link check whose `-w` format names a path ending in a messenger's name
/// read as a message sent as the user, and as a redirect.
#[test]
fn a_curl_format_string_is_text_not_a_command() {
    let check = "cd ~/Desktop/Projects/fictional-site && URL=$(grep -o 'https://[^\"]*' lib/links.ts | head -1); \
                 curl -sIL -m 15 -o /dev/null -w \"%{http_code} %{url_effective}\\n\" \"$URL\"; \
                 curl -s -m 15 -o /dev/null -w \"example.test/slack -> %{http_code}\\n\" https://example.test/slack";
    assert!(!command_sends(check));
    assert!(!card_at(Level::FullSend, check));
    assert!(!card_at(Level::GoHard, check));
    // A substitution in its arguments still runs, and is judged.
    assert!(card_at(
        Level::FullSend,
        "curl -s \"https://example.test/$(rm -rf ~)\""
    ));
    // Real sends are unchanged.
    assert!(command_sends(
        "curl -X POST https://slack.com/api/chat.postMessage -d 'text=hi'"
    ));
}

/// An awk program that matches a tag (`/<\/style>/`) isn't a redirect into
/// `/`; one that runs commands or writes files is still read as code.
#[test]
fn an_awk_program_that_only_prints_is_text() {
    let strip = "S=~/Desktop/Projects/fictional-site/src; for f in $S/pages/index.astro; do \
                 awk '/<style/{s=1} !s{printf \"%d: %s\\n\", NR, $0} /<\\/style>/{s=0}' $f | grep -v ':\\s*$'; done";
    assert!(!card_at(Level::FullSend, strip));
    assert!(!card_at(Level::GoHard, strip));
    assert!(awk_is_text("/<style/{s=1} !s{print} /<\\/style>/{s=0}"));
    assert!(awk_is_text("{ n += $2 } END { print n }"));
    // Anything that could run or write keeps the shell reading.
    for program in [
        "{ system(\"rm -rf ~\") }",
        "{ print | \"sh\" }",
        "{ \"date\" | getline d }",
        "{ print $0 > \"/etc/hosts\" }",
        "{ print $1/2 > \"/tmp/x\" }",
        "/unterminated",
    ] {
        assert!(!awk_is_text(program), "{program}");
    }
}

/// `D=<folder>; rm -rf $D` is judged as `rm -rf <folder>`.
#[test]
fn a_variable_the_line_sets_is_filled_in() {
    let project = "~/Desktop/Projects/fictional-site";
    for (command, asks) in [
        (format!("D={project}/.shots/r1; rm -rf $D"), false),
        (format!("D=\"{project}/.shots/r1\"; rm -rf \"$D\""), false),
        (format!("D={project}/.shots; rm -rf ${{D}}/r1"), false),
        (format!("S={project}; cd $S && rm -rf dist"), false),
        // The same, pointed somewhere that asks anyway.
        ("D=~/Documents; rm -rf $D".to_string(), true),
        ("D=/; rm -rf $D".to_string(), true),
        // Values it can't know stay unknown, and ask as before.
        (format!("D={project}$(printf /..); rm -rf $D"), true),
        (format!("D=\"{project} ~\"; rm -rf $D"), true),
        (format!("D={project}/*; rm -rf $D"), true),
        (
            format!("D={project}; [ -x a ] && D=~/Documents; rm -rf $D"),
            true,
        ),
        (
            format!("echo ' D={project} '; D={project}`printf /..`; rm -rf $D"),
            true,
        ),
        // A prefix assignment doesn't change what `$D` means to the shell.
        (format!("D={project} rm -rf $D"), true),
        ("for d in a b; do rm -rf $d; done".to_string(), true),
    ] {
        assert_eq!(card_at(Level::FullSend, &command), asks, "{command}");
    }
}

/// A new Vercel project's first deployment is its production one: from a
/// folder not linked yet, `vercel deploy` asks at "Full send"; from a linked
/// one it is the preview it says it is.
// Unix only: the classifier reads Unix paths; on Windows they don't resolve and ask (the safe side).
#[cfg(unix)]
#[test]
fn the_first_deploy_of_a_new_vercel_project_asks() {
    let dir = tempfile::tempdir().unwrap();
    let site = dir.path().join("fictional-site");
    std::fs::create_dir_all(&site).unwrap();
    let c = Ctx {
        cwd: site.clone(),
        ..ctx()
    };
    let card = |command: &str| auto(Level::FullSend, false, "Bash", &bash(command), &c).is_none();
    let at = site.display();
    let new_project = format!(
        "cd {at} && vercel project add fictional-site --scope fictional-team && \
         vercel link --yes --scope fictional-team --project fictional-site && vercel deploy --yes --scope fictional-team"
    );
    assert!(card(&new_project));
    assert!(card(&format!("cd {at} && vercel --yes")));
    assert!(card(&format!("vercel deploy --cwd {at}")));
    // Not deploys.
    assert!(!card(&format!(
        "cd {at} && vercel whoami && vercel --version"
    )));
    std::fs::create_dir_all(site.join(".vercel")).unwrap();
    std::fs::write(site.join(".vercel/project.json"), "{}").unwrap();
    assert!(!card(&format!("cd {at} && vercel deploy --yes")));
    assert!(!card(&format!("cd {at} && vercel")));
    assert!(card(&format!("cd {at} && vercel deploy --prod")));
}
