//! The describer's table: commands agents run (fictional repos, hosts and
//! files), and the words the working line shows for each.

use super::*;

fn doing(command: &str) -> String {
    describe(command, 0)
        .map(|p| p.doing)
        .unwrap_or_else(|| "(nothing)".into())
}

#[test]
fn commands_read_as_plain_words() {
    let table: &[(&str, &str)] = &[
        // The case that started this: a Cypress run through npm exec.
        (
            "npm exec cypress run --config baseUrl=http://localhost:3268 --spec cypress/e2e/pages/**/*.cy.ts,cypress/e2e/flows/*.cy.ts",
            "Running the Cypress tests",
        ),
        ("npx cypress run --browser chrome", "Running the Cypress tests"),
        ("npx cypress open", "Opening Cypress"),
        ("pnpm exec playwright test --project=chromium", "Running the Playwright tests"),
        ("npx playwright install --with-deps", "Installing Playwright's browsers"),
        ("npx jest src/pricing", "Running the Jest tests"),
        ("pnpm vitest run", "Running the Vitest tests"),
        ("npx vitest", "Running the Vitest tests"),
        ("npm test", "Running the tests"),
        ("npm test -- PricingTable", "Running the tests"),
        ("npm run test:e2e", "Running the end-to-end tests"),
        ("yarn test --watch=false", "Running the tests"),
        ("pnpm test", "Running the tests"),
        ("npm install", "Installing packages"),
        ("npm ci --no-audit", "Installing packages"),
        ("pnpm add -D zod", "Installing packages"),
        ("yarn", "Installing packages"),
        ("bun install", "Installing packages"),
        ("npm run build", "Building the project"),
        ("pnpm build", "Building the project"),
        ("pnpm --filter web build", "Building the project"),
        ("npx next build", "Building the Next.js app"),
        ("npm run dev -- --port 3001", "Starting the dev server"),
        ("pnpm lint", "Checking the code for problems"),
        ("npx eslint . --fix", "Fixing code problems"),
        ("npx prettier --check .", "Checking the formatting"),
        ("npx tsc --noEmit", "Checking types"),
        ("npm run seed-demo", "Running the seed-demo script"),
        ("npx create-next-app@latest acme-site", "Creating a project"),
        // git
        ("git status", "Checking what changed"),
        ("git diff --stat", "Looking at the changes"),
        ("git log --oneline -20", "Reading the commit history"),
        ("git fetch origin", "Getting the latest changes"),
        ("git pull --rebase", "Pulling the latest changes"),
        ("git push -u origin feature/pricing", "Pushing changes"),
        ("git push --force-with-lease", "Pushing changes (overwriting)"),
        ("git checkout -b fix/hero", "Creating a branch"),
        ("git switch main", "Switching branches"),
        ("git stash", "Setting aside changes"),
        ("git -C /tmp/acme-site status", "Checking what changed"),
        ("git add -A && git commit -m \"Fix hero\" && git push", "Pushing changes"),
        ("git add -A && git commit -m \"Fix hero\"", "Saving a commit"),
        ("git clone https://github.com/acme/site.git", "Copying a repository"),
        ("git rev-parse --abbrev-ref HEAD", "Checking the repository"),
        // gh, with PR and issue numbers
        ("gh pr view 248 --json title,body", "Looking up PR #248 on GitHub"),
        ("gh pr view https://github.com/acme/site/pull/248", "Looking up PR #248 on GitHub"),
        ("gh pr checks 248 --watch", "Watching the checks on PR #248"),
        ("gh pr create --title \"Fix hero\" --body \"x\"", "Opening a pull request on GitHub"),
        ("gh pr list --state open", "Looking at the pull requests on GitHub"),
        ("gh pr diff 12", "Reading the changes in PR #12"),
        ("gh issue view 31", "Looking up issue #31 on GitHub"),
        ("gh issue comment 31 --body \"Done\"", "Commenting on issue #31 on GitHub"),
        ("gh api repos/acme/site/pulls/248/comments", "Reading the comments on PR #248"),
        ("gh api repos/acme/site/pulls/248", "Looking up PR #248 on GitHub"),
        ("gh api -X POST repos/acme/site/issues/31/comments -f body=hi", "Commenting on issue #31 on GitHub"),
        ("gh api user", "Looking up something on GitHub"),
        ("gh run watch 9911", "Watching a GitHub Actions run"),
        ("gh auth status", "Checking the GitHub sign-in"),
        // the network
        ("curl -s http://localhost:3268/api/health", "Fetching localhost:3268"),
        ("curl -sSL https://api.acme.dev/v1/status | jq .", "Fetching api.acme.dev"),
        ("curl -X POST https://hooks.acme.dev/deploy -d '{}'", "Sending a request to hooks.acme.dev"),
        ("curl -I https://www.acme.dev", "Checking acme.dev"),
        ("wget https://files.acme.dev/a.zip", "Downloading from files.acme.dev"),
        ("open https://vercel.com/acme/site", "Opening vercel.com"),
        // containers, other languages
        ("docker compose up -d --build", "Starting the Docker services"),
        ("docker build -t acme/site .", "Building a Docker image"),
        ("docker ps", "Checking the Docker containers"),
        ("python3 scripts/seed.py --count 3", "Running seed.py"),
        ("python -m pytest -q tests/", "Running the Python tests"),
        ("pytest -x", "Running the Python tests"),
        ("pip install -r requirements.txt", "Installing packages"),
        ("node -e 'console.log(1)'", "Running a short JavaScript snippet"),
        ("node scripts/build-sitemap.mjs", "Running build-sitemap.mjs"),
        ("cargo test --lib", "Running the Rust tests"),
        ("go test ./...", "Running the Go tests"),
        ("make test", "Running the tests"),
        ("brew install ffmpeg", "Installing software with Homebrew"),
        ("vercel --prod", "Deploying to Vercel"),
        ("npx wrangler deploy", "Deploying to Cloudflare"),
        // files
        ("cat src/components/Hero.tsx", "Reading Hero.tsx"),
        ("cat a.ts b.ts c.ts", "Reading 3 files"),
        ("head -n 40 README.md", "Reading README.md"),
        ("tail -f logs/dev.log", "Watching dev.log"),
        ("sed -n '1,80p' src/App.tsx", "Reading App.tsx"),
        ("sed -i '' 's/old/new/' src/App.tsx", "Editing App.tsx"),
        ("rg -n 'PricingTable' src", "Searching the files"),
        ("find . -name '*.test.ts' | head", "Looking for files"),
        ("ls -la", "Looking through the files"),
        ("wc -l src/App.tsx", "Counting the lines in App.tsx"),
        ("mkdir -p dist/assets", "Creating a folder"),
        ("rm -rf node_modules/.cache", "Deleting .cache"),
        ("lsof -i :3268", "Checking what's using port 3268"),
        ("lsof -ti:3000 | xargs kill -9", "Checking what's using port 3000"),
        ("sleep 30", "Waiting 30 seconds"),
        ("which pnpm", "Checking pnpm is installed"),
        // loops: the inner command and how many times
        ("for n in 248 249 250; do gh pr view $n --json title; done", "Looking up a PR on GitHub, 3 times"),
        ("for f in src/*.ts; do wc -l \"$f\"; done", "Counting lines, repeatedly"),
        ("for i in {1..5}; do curl -s http://localhost:3000; sleep 1; done", "Fetching localhost:3000, 5 times"),
        ("while true; do curl -s http://localhost:3000/health; sleep 5; done", "Fetching localhost:3000, repeatedly"),
        // shells, wrappers, setup and redirections
        ("cd /Users/sam/acme-site && npm install && npm test", "Running the tests"),
        ("/bin/zsh -lc 'npm run build'", "Building the project"),
        ("bash -c \"pnpm test\"", "Running the tests"),
        ("CI=1 FORCE_COLOR=0 npx playwright test 2>&1 | tail -40", "Running the Playwright tests"),
        ("timeout 600 npm test > /tmp/out.txt 2>&1", "Running the tests"),
        ("npm test 2>&1; echo \"exit $?\"", "Running the tests"),
        ("python3 - <<'EOF'\nimport os\nprint(os.environ)\nEOF", "Running a Python script"),
        // the fallback: the program's name, never raw shell
        ("ffmpeg -i in.mov out.mp4", "Processing a video"),
        ("terraformer import acme", "Running terraformer"),
        ("./scripts/release.sh minor", "Running release.sh"),
        ("echo hi", "Printing a message"),
        ("echo hi > note.txt && cat note.txt", "Writing note.txt"),
        ("echo esc-ok > /tmp/probe.txt", "Writing probe.txt"),
        ("echo ok > /dev/null", "Printing a message"),
        ("cat > config.json <<EOF\n{\"a\": 1}\nEOF", "Writing config.json"),
    ];
    let mut wrong = Vec::new();
    for (command, want) in table {
        let got = doing(command);
        if got != *want {
            wrong.push(format!("{command:?}\n   want {want:?}\n    got {got:?}"));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} wrong:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
    assert!(table.len() >= 60);
}

#[test]
fn every_form_of_a_phrase_agrees() {
    let p = describe("npm exec cypress run --spec x", 0).unwrap();
    assert_eq!(p.doing, "Running the Cypress tests");
    assert_eq!(p.done, "Ran the Cypress tests");
    assert_eq!(p.ask, "run the Cypress tests");
    assert_eq!(p.slow, Some(Slow::Tests));
    let p = describe("gh pr view 248", 0).unwrap();
    assert_eq!(p.done, "Looked up PR #248 on GitHub");
    assert_eq!(p.ask, "look up PR #248 on GitHub");
    assert_eq!(p.slow, None);
}

#[test]
fn slow_tools_are_marked() {
    for (command, kind) in [
        ("npm install", Slow::Install),
        ("pnpm build", Slow::Build),
        ("npx vitest run", Slow::Tests),
        ("vercel deploy", Slow::Deploy),
    ] {
        assert_eq!(describe(command, 0).unwrap().slow, Some(kind), "{command}");
    }
    assert_eq!(describe("git status", 0).unwrap().slow, None);
}

#[test]
fn nothing_to_say_is_none() {
    for command in [
        "",
        "   ",
        "# just a comment",
        "cd /tmp",
        "export A=1 && cd x",
    ] {
        assert_eq!(describe(command, 0), None, "{command:?}");
    }
}

#[test]
fn arguments_never_reach_the_words() {
    // Paths, tokens, URLs' paths and queries, commit messages: none of it.
    for command in [
        "curl -H 'Authorization: Bearer sk-live-0123456789abcdef' https://api.acme.dev/v1/keys?token=abc123",
        "git commit -m 'password is hunter2'",
        "gh api repos/acme/secret-repo/pulls/248 -H 'X-Token: ghp_0123456789abcdefABCDEF'",
        "npm run build -- --token=ghp_0123456789abcdefABCDEF",
        "STRIPE_KEY=sk_live_abcdefghijklmnop node scripts/charge.js",
        "psql postgres://admin:hunter2@db.acme.dev/prod -c 'select 1'",
    ] {
        let p = describe(command, 0).unwrap();
        for leaked in ["hunter2", "sk-live", "sk_live", "ghp_", "abc123", "secret-repo", "admin", "/v1/keys"] {
            assert!(
                !p.doing.contains(leaked) && !p.done.contains(leaked) && !p.ask.contains(leaked),
                "{leaked} leaked from {command}: {p:?}"
            );
        }
    }
}

#[test]
fn odd_input_never_panics() {
    for command in [
        "'unterminated",
        "\"also",
        "$(",
        "a <<",
        "cat <<EOF",
        "for",
        "for x in",
        "while",
        "done done done",
        "|||&&&;;;",
        "2>&1",
        "> /dev/null",
        "é ü 漢字 🚀",
        "gh pr view #",
        "curl http://[::1]:3000/",
        "sleep abc",
        "bash -c",
        "npm",
        "npx",
        "git -C",
    ] {
        let _ = describe(command, 0);
    }
}
