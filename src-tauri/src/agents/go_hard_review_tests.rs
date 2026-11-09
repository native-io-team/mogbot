//! Shell spellings that ran an ask-list command without a card (found in
//! review, 2026-11-08). Paths and hosts fictional.

use super::*;
use serde_json::json;

const HOME: &str = "/Users/fictional-tester";

fn ctx(full_send: bool) -> Ctx {
    let app = format!("{HOME}/Library/Application Support/FictionalApp");
    let own = format!("{app}/agents/a1");
    Ctx {
        home: HOME.into(),
        own_home: own.clone().into(),
        cwd: own.clone().into(),
        scratch: vec![own.into()],
        app_data: vec![app.into()],
        full_send,
        ..Default::default()
    }
}

fn go_hard(command: &str) -> bool {
    asks("Bash", &json!({ "command": command }), &ctx(false), false)
}

fn full_send(command: &str) -> bool {
    asks("Bash", &json!({ "command": command }), &ctx(true), false)
}

/// Bash and zsh read `$'…'` as a quoted word with escapes: `git $'push'` is
/// `git push`, and `$'a\''` closes before the redirect after it.
#[test]
fn ansi_c_quoting_is_the_word_it_makes() {
    for cmd in [
        "git $'push' origin main",
        "$'git' push",
        "$'sudo' ls",
        "git $'\\x70ush'",
        "echo $'a\\'' > ~/.zshrc",
        "bash -c $'git push'",
        "git $\"push\"",
    ] {
        assert!(go_hard(cmd), "asks at Go hard: {cmd}");
    }
    // Pushing to a protected branch is on Full send's floor too.
    assert!(full_send("git $'push' origin main"));
    // Still text where it is text.
    assert!(!go_hard("printf $'a\\tb\\n' > notes.txt"));
}

/// Quoted text kept in a variable or given to `echo` is data only while no
/// shell reads it. A shell behind a wrapper with arguments, `find -exec`,
/// `$SHELL` or an interpreter's inline code reads it all the same.
#[test]
fn data_handed_to_a_wrapped_shell_is_commands() {
    for cmd in [
        "X='echo hi >> ~/.zshrc'; timeout 5 sh -c \"$X\"",
        "X='echo hi >> ~/.zshrc'; nice -n 5 sh -c \"$X\"",
        "X='echo hi >> ~/.zshrc'; $SHELL -c \"$X\"",
        "X='echo hi >> ~/.zshrc'; find . -maxdepth 0 -exec sh -c \"$X\" ';'",
        "X='echo hi >> ~/.zshrc'; script -q /dev/null sh -c \"$X\"",
        "X='echo hi >> ~/.zshrc'; python3 -c \"import os; os.system('$X')\"",
        "echo 'echo hi >> ~/.zshrc' | timeout 5 sh",
        "echo 'echo hi >> ~/.zshrc' | python3 -c \"import sys,os; os.system(sys.stdin.read())\"",
    ] {
        assert!(go_hard(cmd), "asks at Go hard: {cmd}");
        assert!(
            full_send(cmd),
            "system persistence asks at Full send: {cmd}"
        );
    }
    // HTML built with echo is still not a redirect.
    assert!(!go_hard(
        "echo \"<style>$(cat a.css)</style></head>\" > page.html"
    ));
    assert!(!go_hard(
        "X='<p>x</p></body>'; echo \"$X\" > page.html; python3 -m http.server 8000 &"
    ));
}

/// Wrappers whose options take a value (`nice -n 5`, `env -u X`), and
/// `time -p`, run the command after them.
#[test]
fn wrapper_options_with_values_are_skipped() {
    for cmd in [
        "nice -n 5 git push",
        "nice -n 5 sudo ls",
        "time -p sudo ls",
        "env -u FOO git push",
        "env -C /tmp git push",
        "caffeinate -t 5 git push",
        "arch -arm64 git push",
        "arch -arm64 sudo ls",
        "exec -a x git push",
        "lockf -k /tmp/l git push",
    ] {
        assert!(go_hard(cmd), "asks at Go hard: {cmd}");
    }
    assert!(full_send("nice -n 5 git push origin main"));
    assert!(!go_hard("nice -n 5 npm run build"));
}

/// `>|` writes like `>` (it overrides `noclobber`).
#[test]
fn a_clobbering_redirect_is_a_write() {
    assert!(go_hard("echo a >| ~/.zshrc"));
    assert!(go_hard("echo a 2>| ~/.zshrc"));
    assert!(full_send("echo a >| ~/.zshrc"));
    assert!(!go_hard("echo a >| notes.txt"));
}

/// `pushd` moves the shell like `cd`.
#[test]
fn pushd_is_followed_like_cd() {
    assert!(go_hard("pushd ~ && rm -rf Documents"));
    assert!(go_hard("pushd ~ >/dev/null; rm -rf Documents"));
    // A `cd` it can't follow leaves the shell somewhere unknown.
    assert!(go_hard("D=~; cd \"$D\" && rm -rf Documents"));
    assert!(go_hard("cd -P ~ && rm -rf Documents"));
    assert!(go_hard("cd ~/Desktop && popd && rm -rf Documents"));
    assert!(!go_hard(
        "cd ~/Desktop/Projects/fix-268 && rm -rf node_modules"
    ));
    assert!(!go_hard("pushd /tmp && rm -rf build-cache"));
}

/// A package runner runs the command it names: `pnpm dlx vercel --prod`
/// deploys like `npx vercel --prod`.
#[test]
fn package_runners_are_judged_by_what_they_run() {
    for cmd in [
        "pnpm dlx vercel --prod",
        "pnpm exec vercel --prod",
        "npm exec -- vercel --prod",
        "npm exec --yes -- netlify deploy --prod",
        "yarn dlx vercel --prod",
        "yarn exec vercel --prod",
        "yarn vercel --prod",
        "bun x vercel --prod",
        "pnpm exec git push",
    ] {
        assert!(go_hard(cmd), "asks at Go hard: {cmd}");
    }
    assert!(full_send("pnpm dlx vercel --prod"));
    for cmd in [
        "pnpm exec next build",
        "pnpm exec tsc --noEmit",
        "yarn build",
        "yarn",
        "pnpm dlx create-next-app@latest app",
        "npm exec -- prettier --write .",
    ] {
        assert!(!go_hard(cmd), "runs at Go hard: {cmd}");
    }
}
