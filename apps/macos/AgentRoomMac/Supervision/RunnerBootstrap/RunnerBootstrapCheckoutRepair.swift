import Foundation

/// The fix a source checkout needs before its entrypoint can launch, run in
/// Terminal so the operator watches every step.
///
/// The script is fixed here and only the checkout path and revision are
/// substituted, quoted for zsh. It refuses a folder that is not a Git checkout,
/// and a checkout with uncommitted changes to tracked files rather than letting
/// `git checkout` carry or reject them halfway through. It fetches only when
/// the revision is not already present, so a checkout without an `origin`
/// remote can still move to a commit it has.
enum RunnerBootstrapCheckoutRepair: Equatable {
    /// Move the checkout to the tested revision, then install and build.
    case update(revision: String)
    /// Install and build the sources already checked out.
    case build

    var title: String {
        switch self {
        case .update:
            "Update in Terminal"
        case .build:
            "Build in Terminal"
        }
    }

    /// Lead-in to "then check again" in the pane, phrased for the button.
    var instruction: String {
        switch self {
        case .update:
            "Update it in Terminal, then check again."
        case .build:
            "Build it in Terminal, then check again."
        }
    }

    func script(root: URL) -> String {
        let path = RunnerSignInCommand.shellQuoted(root.path)
        let steps: String
        switch self {
        case .update(let revision):
            let quoted = RunnerSignInCommand.shellQuoted(revision)
            let commit = RunnerSignInCommand.shellQuoted("\(revision)^{commit}")
            steps = """
            git rev-parse --is-inside-work-tree >/dev/null 2>&1 || stop "This folder is not a Git checkout, so it cannot be updated. Clone it again, then choose the new folder."
            if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
              echo "This checkout has uncommitted changes:"
              git status --short --untracked-files=no
              stop "Commit, stash, or discard them, then choose Update in Terminal again."
            fi
            if ! git cat-file -e \(commit) 2>/dev/null; then
              git remote get-url origin >/dev/null 2>&1 || stop "This checkout has no remote named origin to fetch the pinned commit from. Add one, then choose Update in Terminal again."
              run git fetch origin
            fi
            run git checkout --detach \(quoted)
            """
        case .build:
            steps = ""
        }
        return """
        #!/bin/zsh
        rm -f -- "$0"
        stop() { echo; echo "$1"; exit 1; }
        run() { echo "> $*"; "$@" || stop "That step failed. Fix the error above, then try again from AgentRoom."; }
        cd -- \(path) || stop "Could not open the checkout."
        command -v pnpm >/dev/null 2>&1 || stop "pnpm is not installed. Run corepack enable pnpm, then try again."
        \(steps)
        run pnpm install --frozen-lockfile
        run pnpm run build
        echo
        echo "Done. Return to AgentRoom and choose Check again."

        """
    }
}
