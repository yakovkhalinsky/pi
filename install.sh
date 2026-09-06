#!/bin/sh
# install.sh — recreate ~/.pi from this backup.
#
# Idempotent and safe to re-run: it never overwrites existing secrets
# (auth.json, models-store.json, models.json) or existing config dirs.
# Everything is PINNED to versions verified warning-free (npm audit clean,
# every install script covered by the allowScripts policy) — the installer
# never floats anything to "latest", so re-running it is reproducible. It
# pins the extension packages to the tested versions, copies portable
# config that is missing, removes other installed `pi` executables that
# would shadow the wrapper shim (a mise-managed pi, a mise-forcing wrapper
# in ~/.local/bin), and adds the PATH entry to the shell's rc file.
#
# To bump versions deliberately: install/test the new pi or extension
# versions, resolve any new npm audit findings and install-script warnings
# (update allowScripts in agent/npm/package.json), then update PI_VERSION
# here and the pins in agent/npm/package.json + agent/settings.json.
#
# Source layout (repo root):
#   AGENTS.md                       agent rules (public-safe hygiene, docs sync)
#   bin/pi                          wrapper shim
#   agent/agents/  prompts/  extensions/  skills/   portable config
#   agent/settings.json             safe prefs (no secrets); packages pinned
#   agent/pi-pretty.json            pi-pretty extension config (safe prefs)
#   agent/models.example.json       sanitized provider template (apiKey: "")
#   agent/npm/.gitignore            self-ignoring npm cache marker
#   agent/npm/package.json          pinned extension manifest (exact versions
#                                   + diff security override + allowScripts
#                                   install-script policy)
#   scripts/check-public-safe.sh    secret/private-info scanner (--all | staged)
#   .githooks/pre-commit            runs the scanner before every commit
#   .github/workflows/public-safe.yml  runs the scanner on every push/PR
#
# Usage:  git clone git@github.com:yakovkhalinsky/pi.git && cd pi && ./install.sh
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
PI_HOME="$HOME/.pi"
PI_NODE="$PI_HOME/node"
PI_AGENT="$PI_HOME/agent"
PI_BIN="$PI_HOME/bin"

# Node.js Active LTS "Krypton" (v24.x; Active LTS since 2025-10-28, EOL 2028-04-30).
# Latest v24 patch as of 2026-08-21. This is a MAJOR-version bump from the
# original v22 "Jod" line the backup shipped with (authorised 2026-08-21).
# To bump: open https://nodejs.org/dist/index.json, take the newest entry whose
# "lts" == "Krypton", and set NODE_VERSION to its "version".
# To switch LTS lines (e.g. back to v22 "Jod" maintenance LTS), set NODE_VERSION
# to that line's release and re-test pi on it first — that is a major change.
NODE_VERSION="v24.19.0"

# pi 0.85.1 — verified 2026-09-06: installs clean, npm audit clean (diff
# CVE-2026-24001 fixed via the manifest override), every install script
# covered by the manifest allowScripts policy.
# To bump: install the candidate version, run the full check (pi
# update --extensions, `npm audit` in ~/.pi/agent/npm), review any new
# install-script warnings, then set PI_VERSION — and update the extension
# pins in agent/npm/package.json + agent/settings.json to tested versions.
PI_VERSION="0.85.1"

# ---------------------------------------------------------------------------
# 0. Detect architecture → pick the right Node tarball
# ---------------------------------------------------------------------------
ARCH="$(uname -m)"
OS="$(uname -s)"
case "$OS" in
  Darwin) NODE_OS="darwin" ;;
  Linux)  NODE_OS="linux"  ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac
case "$ARCH" in
  arm64|aarch64) NODE_ARCH="arm64" ;;
  x86_64|amd64) NODE_ARCH="x64"   ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac
NODE_TAR="node-${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}.tar.xz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TAR}"

# ---------------------------------------------------------------------------
# 1. Bundled Node
#
#    On a version mismatch (or missing Node), download + extract Node into a
#    STAGING directory under $PI_HOME, verify the staged binary runs and
#    reports exactly $NODE_VERSION, then SWAP it into place: move the old
#    $PI_NODE aside, move the staged dir in, and on success drop the old one.
#    Extraction-in-place is intentionally NOT used for upgrades — extracting
#    a new tarball on top of an existing $PI_NODE would leave stale files from
#    the previous version mixed in, corrupting the install. A failed or
#    aborted upgrade always removes the staging dir and leaves any existing
#    Node intact (rolled back), so ~/.pi/node is never left broken.
#
#    Staging lives under $PI_HOME (not /tmp) so the final `mv` is a
#    same-filesystem, atomic rename on both macOS and Linux.
# ---------------------------------------------------------------------------
mkdir -p "$PI_HOME"
if [ -x "$PI_NODE/bin/node" ] && "$PI_NODE/bin/node" -v 2>/dev/null | grep -q "$NODE_VERSION"; then
  echo ">> Node ${NODE_VERSION} already present at $PI_NODE — skipping download"
else
  STAGING="$PI_NODE.new.$$"
  rm -rf "$STAGING"                      # clear any leftover staging dir from a prior aborted run
  mkdir -p "$STAGING"
  echo ">> Downloading Node ${NODE_VERSION} (${NODE_OS}-${NODE_ARCH}) → $STAGING"
  if curl -fL "$NODE_URL" | tar -xJ --strip-components=1 -C "$STAGING" \
     && [ -x "$STAGING/bin/node" ] \
     && "$STAGING/bin/node" -v 2>/dev/null | grep -q "$NODE_VERSION"; then
    # Verified — swap into place with a rollback backup.
    ROLLBACK=""
    if [ -d "$PI_NODE" ]; then
      if ! mv "$PI_NODE" "$PI_NODE.old.$$"; then
        rm -rf "$STAGING"
        echo ">> ERROR: could not move existing Node aside — staging removed, existing Node untouched" >&2
        exit 1
      fi
      ROLLBACK="$PI_NODE.old.$$"
    fi
    if ! mv "$STAGING" "$PI_NODE"; then
      # swap-in failed: restore the previous Node (if any), drop staging.
      if [ -n "$ROLLBACK" ] && [ -d "$ROLLBACK" ]; then
        mv "$ROLLBACK" "$PI_NODE"
      fi
      rm -rf "$STAGING"
      echo ">> ERROR: failed to install Node ${NODE_VERSION} — rolled back" >&2
      exit 1
    fi
    if [ -n "$ROLLBACK" ]; then
      rm -rf "$ROLLBACK"                  # success: drop the rollback backup
    fi
    echo ">> Node ${NODE_VERSION} installed at $PI_NODE"
  else
    rm -rf "$STAGING"
    echo ">> ERROR: Node ${NODE_VERSION} download/verification failed — staging dir removed, existing Node untouched" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 2. pi npm package (global install into ~/.pi/node prefix) — PINNED
#
#    PI_VERSION is a deliberate pin, never resolved from the registry at run
#    time, so re-running install.sh is reproducible: it upgrades an outdated
#    install (and downgrades back to the pin if a newer one was installed
#    manually). The check uses `npm ls -g pkg@<version>`: exit 0 only when
#    exactly the pinned version is installed.
# ---------------------------------------------------------------------------
export npm_config_prefix="$PI_NODE"
echo ">> Checking pinned pi version ${PI_VERSION}"
if "$PI_NODE/bin/npm" ls -g "@earendil-works/pi-coding-agent@$PI_VERSION" >/dev/null 2>&1; then
  echo ">> pi ${PI_VERSION} already installed — skipping npm install"
else
  echo ">> Installing pinned @earendil-works/pi-coding-agent@${PI_VERSION} into $PI_NODE"
  "$PI_NODE/bin/npm" install -g "@earendil-works/pi-coding-agent@${PI_VERSION}"
fi

# ---------------------------------------------------------------------------
# 3. Wrapper shim
# ---------------------------------------------------------------------------
mkdir -p "$PI_BIN"
install -m 0755 "$HERE/bin/pi" "$PI_BIN/pi"
echo ">> Installed wrapper shim → $PI_BIN/pi"

# ---------------------------------------------------------------------------
# 3b. Remove other `pi` executables that would shadow the wrapper shim
#
#     Whichever executable named `pi` resolves first on PATH runs when the
#     user types `pi`. A second, independently-managed pi (typically a
#     version-manager copy, or a wrapper script that re-execs the version
#     manager) therefore shadows the pinned install whenever it wins PATH
#     order — and because rc files commonly add version-manager paths AFTER
#     this installer's PATH entry, and shells opened before the install keep
#     their old PATH, the user ends up on an outdated pi with stale "update
#     available" notifications even though the pinned version is installed.
#     Known shadow sources are removed:
#       - a ~/.local/bin/pi wrapper that drives mise
#       - a mise-managed pi: uninstall all installed versions, drop the tool
#         entry from the global mise config (otherwise the next `mise
#         install`/`mise reshim` would silently bring the shadow back), and
#         re-shim so stale pi shims disappear
#     Any other `pi` found on PATH is left untouched and reported on stderr
#     (the installer can't classify it safely). Project-local mise configs
#     that request pi are out of scope. Set PI_KEEP_MISE_PI=1 to skip the
#     mise cleanup (not recommended — see above). Idempotent: with no
#     shadows present this step is a no-op.
# ---------------------------------------------------------------------------
PI_MISE_HOME="$HOME/.local/share/mise"
pi_shadow_fixed=""
pi_leftover=""

# 3b-1. mise-managed pi (checks mise's data dir and global config, not just
#       the PATH the installer inherited — shadows can exist off-PATH too)
if [ -n "$PI_KEEP_MISE_PI" ]; then
  echo ">> PI_KEEP_MISE_PI=1 — keeping any mise-managed pi (it may shadow $PI_BIN/pi)" >&2
elif command -v mise >/dev/null 2>&1; then
  pi_mise_cfg1="${MISE_GLOBAL_CONFIG_FILE:-$HOME/.config/mise/config.toml}"
  if [ -d "$PI_MISE_HOME/installs/pi" ] || [ -e "$PI_MISE_HOME/shims/pi" ] \
     || grep -qsE '^[[:space:]]*pi[[:space:]]*=' "$pi_mise_cfg1" "$HOME/.mise.toml" 2>/dev/null; then
    echo ">> Removing mise-managed pi (shadows $PI_BIN/pi depending on PATH order)"
    if ! mise uninstall pi; then
      echo ">> WARNING: 'mise uninstall pi' failed — remove mise's pi manually" >&2
    fi
    for pi_mise_cfg in "$pi_mise_cfg1" "$HOME/.mise.toml"; do
      [ -f "$pi_mise_cfg" ] || continue
      grep -qE '^[[:space:]]*pi[[:space:]]*=' "$pi_mise_cfg" || continue
      if grep -qE '^[[:space:]]*pi[[:space:]]*=[[:space:]]*\[' "$pi_mise_cfg"; then
        echo ">> WARNING: $pi_mise_cfg defines pi as a multi-line TOML array — not auto-editing." >&2
        echo ">>          Remove the pi entry manually or mise will re-install it and it" >&2
        echo ">>          will shadow $PI_BIN/pi again" >&2
        continue
      fi
      pi_mise_tmp="$pi_mise_cfg.tmp.$$"
      if awk -v cfg="$pi_mise_cfg" '
        /^\[/ { intools = ($0 ~ /^\[tools\][[:space:]]*(#.*)?$/); print; next }
        intools && /^[[:space:]]*pi[[:space:]]*=/ { printf ">>   %s: removed %s\n", cfg, $0 > "/dev/stderr"; next }
        { print }
      ' "$pi_mise_cfg" > "$pi_mise_tmp" && mv "$pi_mise_tmp" "$pi_mise_cfg"; then
        echo ">> Dropped the pi entry from $pi_mise_cfg (mise would otherwise re-install it)"
      else
        rm -f "$pi_mise_tmp"
        echo ">> WARNING: could not rewrite $pi_mise_cfg — remove its 'pi =' entry manually," >&2
        echo ">>          or mise will re-install pi and it will shadow $PI_BIN/pi again" >&2
      fi
    done
    if ! mise reshim; then
      echo ">> WARNING: 'mise reshim' failed — run it manually to drop stale pi shims" >&2
    fi
    rm -f "$PI_MISE_HOME/shims/pi"    # belt-and-braces: no tool, no shim
    pi_shadow_fixed=1
  fi
fi

# 3b-2. ~/.local/bin/pi wrapper (a script or symlink that launches a
#       version-manager pi regardless of PATH order)
pi_local_bin="$HOME/.local/bin/pi"
pi_action=""
if [ -L "$pi_local_bin" ]; then
  pi_link_target="$(readlink "$pi_local_bin" 2>/dev/null || true)"
  case "$pi_link_target" in
    "$PI_BIN/pi") pi_action="keep" ;;  # points at our shim — fine
    *mise*)           pi_action="remove" ;;
    *)                pi_action="warn" ;;
  esac
elif [ -f "$pi_local_bin" ]; then
  if grep -qs 'mise' "$pi_local_bin" && grep -qs 'pi' "$pi_local_bin"; then
    pi_action="remove"                 # wrapper that re-execs mise's pi
  else
    pi_action="warn"                   # unknown content — don't touch it
  fi
fi
if [ "$pi_action" = "remove" ] && [ -n "$PI_KEEP_MISE_PI" ]; then
  pi_action="warn"
fi
case "$pi_action" in
  remove)
    rm -f "$pi_local_bin"
    echo ">> Removed $pi_local_bin (it resolves to mise's pi instead of $PI_BIN/pi)"
    pi_shadow_fixed=1
    ;;
  warn) pi_leftover="$pi_leftover $pi_local_bin" ;;
esac

# 3b-3. Report any remaining `pi` on PATH that this installer doesn't manage
OLDIFS="$IFS"; IFS=:
for pi_dir in $PATH "$HOME/.local/bin"; do
  IFS="$OLDIFS"
  case "$pi_dir" in "") continue ;; esac
  pi_cand="$pi_dir/pi"
  [ -f "$pi_cand" ] || continue
  case "$pi_cand" in "$PI_BIN/pi"|"$PI_NODE/bin/pi") continue ;; esac
  case " $pi_leftover " in *" $pi_cand "*) continue ;; esac
  pi_leftover="$pi_leftover $pi_cand"
done
IFS="$OLDIFS"
for pi_cand in $pi_leftover; do
  echo ">> WARNING: found another 'pi' at $pi_cand — not managed by this installer, left in place." >&2
  echo ">>          If it resolves before $PI_BIN/pi it shadows the pinned install (stale" >&2
  echo ">>          update notifications). Remove it or make sure $PI_BIN comes first on PATH." >&2
done

# ---------------------------------------------------------------------------
# 4. Portable config dirs (never overwrite existing ones)
# ---------------------------------------------------------------------------
mkdir -p "$PI_AGENT"
for d in agents prompts extensions skills; do
  if [ -d "$PI_AGENT/$d" ]; then
    echo ">> ~/.pi/agent/$d already exists — skipping (not overwriting)"
  else
    cp -R "$HERE/agent/$d" "$PI_AGENT/$d"
    echo ">> Copied agent/$d → $PI_AGENT/$d"
  fi
done

# ---------------------------------------------------------------------------
# 5. settings.json (only if missing — preserves local tweaks)
# ---------------------------------------------------------------------------
if [ -f "$PI_AGENT/settings.json" ]; then
  echo ">> ~/.pi/agent/settings.json already exists — skipping (not overwriting)"
else
  cp "$HERE/agent/settings.json" "$PI_AGENT/settings.json"
  echo ">> Copied settings.json → $PI_AGENT/settings.json"
fi

# ---------------------------------------------------------------------------
# 5b. pi-pretty.json (only if missing — preserves local tweaks)
#     Extension config for pi-pretty (icons, tool rendering opts). Safe prefs.
# ---------------------------------------------------------------------------
if [ -f "$PI_AGENT/pi-pretty.json" ]; then
  echo ">> ~/.pi/agent/pi-pretty.json already exists — skipping (not overwriting)"
else
  cp "$HERE/agent/pi-pretty.json" "$PI_AGENT/pi-pretty.json"
  echo ">> Copied pi-pretty config → $PI_AGENT/pi-pretty.json"
fi

# ---------------------------------------------------------------------------
# 5c. Pin extension package specs in settings.json
#
#     The template lists packages as versioned specs (npm:foo@1.2.3), which
#     pi treats as pinned: it loads exactly that version and `pi update
#     --extensions` skips pinned specs by design. For an existing
#     settings.json (which the installer never overwrites), rewrite the
#     version of every entry whose package name appears in the template
#     manifest — preserving each entry's identity (string vs object form)
#     and any filters. Entries for other packages, and the rest of
#     settings.json, are left untouched; nothing is added or removed.
# ---------------------------------------------------------------------------
if [ -f "$PI_AGENT/settings.json" ]; then
  "$PI_NODE/bin/node" - "$HERE/agent/npm/package.json" "$PI_AGENT/settings.json" <<'NODE_EOF'
const fs = require("fs");
const [tplPath, livePath] = process.argv.slice(2);
const tpl = JSON.parse(fs.readFileSync(tplPath, "utf8"));
const settings = JSON.parse(fs.readFileSync(livePath, "utf8"));
if (!Array.isArray(settings.packages)) process.exit(0);
const nameOf = (spec) => {
  const m = /^npm:(.+)$/.exec(spec);
  if (!m) return null;
  const at = m[1].lastIndexOf("@"); // scoped names keep their leading @
  return at <= 0 ? m[1] : m[1].slice(0, at);
};
let changed = false;
settings.packages = settings.packages.map((p) => {
  const isObj = p !== null && typeof p === "object";
  const src = isObj ? p.source : p;
  if (typeof src !== "string") return p;
  const name = nameOf(src);
  const pin = name && tpl.dependencies[name];
  if (!pin) return p;
  const spec = "npm:" + name + "@" + pin;
  if (src === spec) return p;
  changed = true;
  console.log(">> Pinning " + name + " → " + spec);
  return isObj ? Object.assign({}, p, { source: spec }) : spec;
});
if (changed) fs.writeFileSync(livePath, JSON.stringify(settings, null, 2) + "\n");
NODE_EOF
fi

# ---------------------------------------------------------------------------
# 6. models.json — copy the sanitized template ONLY if the user has none.
#    The committed template (models.example.json) has apiKey: "".
#    Never overwrite an existing models.json (the user fills in real keys).
# ---------------------------------------------------------------------------
if [ -f "$PI_AGENT/models.json" ]; then
  echo ">> ~/.pi/agent/models.json already exists — skipping (not overwriting)"
else
  cp "$HERE/agent/models.example.json" "$PI_AGENT/models.json"
  echo ">> Copied sanitized models template → $PI_AGENT/models.json (edit to add apiKey)"
fi

# ---------------------------------------------------------------------------
# 7. Empty secret placeholders (recreated if absent; user fills via pi login)
# ---------------------------------------------------------------------------
[ -f "$PI_AGENT/auth.json" ]         || echo '{}' > "$PI_AGENT/auth.json"
[ -f "$PI_AGENT/models-store.json" ] || echo '{}' > "$PI_AGENT/models-store.json"
echo ">> Ensured empty auth.json / models-store.json placeholders"

# ---------------------------------------------------------------------------
# 8. npm extensions manifest — PINNED + policy (so `pi` can resolve
#    installed extensions and installs stay warning-free)
#
#     The manifest is the source of truth for extension versions and carries
#     two deliberate security/compat fields:
#     - exact version pins for every extension (no ^ ranges — re-running the
#       installer is reproducible; bump deliberately via the repo)
#     - "overrides": forces @heyhuynhgiabuu/pi-diff's transitive `diff` to
#       ^8.0.3 (CVE-2026-24001 / GHSA-73rr-hh4g-fpgx, jsdiff DoS in
#       parsePatch/applyPatch; no patched 7.x exists). Scoped to pi-diff
#       only — pi's own nested diff is already patched upstream.
#     - "allowScripts": npm 11.x (RFC npm/rfcs#868) advisory allowlist for
#       lifecycle scripts that have been reviewed here and are benign:
#       @google/genai (echo no-op), esbuild (validates its platform
#       binary), protobufjs (regenerates dist). Approved name-only, so
#       future versions keep working without re-approval — re-review this
#       list when extension deps change. Unlisted packages still run their
#       scripts but emit an advisory warning.
#
#     The template is MERGED into an existing manifest (template wins for
#     dependencies/overrides/allowScripts; packages the user added via
#     `pi install` are preserved), so pre-policy installs get the fixes too.
#     Then node_modules is always reconciled to the merged manifest —
#     `npm install` is a no-op when already satisfied.
# ---------------------------------------------------------------------------
mkdir -p "$PI_AGENT/npm"
[ -f "$PI_AGENT/npm/.gitignore" ] || cp "$HERE/agent/npm/.gitignore" "$PI_AGENT/npm/.gitignore"
[ -f "$PI_AGENT/npm/package.json" ] || cp "$HERE/agent/npm/package.json" "$PI_AGENT/npm/package.json"
"$PI_NODE/bin/node" - "$HERE/agent/npm/package.json" "$PI_AGENT/npm/package.json" <<'NODE_EOF'
const fs = require("fs");
const [tplPath, livePath] = process.argv.slice(2);
const tpl = JSON.parse(fs.readFileSync(tplPath, "utf8"));
let live;
try { live = JSON.parse(fs.readFileSync(livePath, "utf8")); }
catch { live = {}; }
const merged = Object.assign({}, live, {
  dependencies: Object.assign({}, live.dependencies, tpl.dependencies),
  overrides: Object.assign({}, live.overrides, tpl.overrides),
  allowScripts: Object.assign({}, live.allowScripts, tpl.allowScripts),
});
if (JSON.stringify(merged) !== JSON.stringify(live)) {
  fs.writeFileSync(livePath, JSON.stringify(merged, null, 2) + "\n");
  console.log(">> Merged pinned manifest (versions + overrides + allowScripts) → " + livePath);
}
NODE_EOF
echo ">> Reconciling pi extension deps to pinned versions (npm install in ~/.pi/agent/npm)"
( cd "$PI_AGENT/npm" && "$PI_NODE/bin/npm" install --no-audit --no-fund )

# ---------------------------------------------------------------------------
# 8b. Extension packages — reconcile via pi's own updater
#
#     Extension specs in settings.json are version-pinned (section 5c), and
#     pi skips pinned specs by design — so this run floats nothing to
#     latest. It repairs any missing install and reconciles pinned git refs
#     (clones are reset to their configured ref, refs are not moved).
#     --no-approve keeps the run non-interactive (project-local settings are
#     ignored; this installer only manages the global ~/.pi install).
#     To update extensions deliberately: bump the pins in
#     agent/npm/package.json and agent/settings.json, re-run ./install.sh,
#     and review any new audit findings / install-script warnings.
#     Non-fatal: pi itself and the pinned npm deps are already in place, so
#     a failure here only warns — re-run ./install.sh to retry.
# ---------------------------------------------------------------------------
echo ">> Reconciling installed pi extensions (pi update --extensions)"
if "$PI_BIN/pi" update --extensions --no-approve; then
  echo ">> Extensions reconciled"
else
  echo ">> WARNING: 'pi update --extensions' failed — re-run ./install.sh to retry" >&2
fi

# ---------------------------------------------------------------------------
# 9. PATH — add the pi bin dir to the shell's rc file once
#
#    Detects the user's shell ($SHELL, falling back to /etc/passwd) and
#    appends the entry with the right syntax to the right file:
#      zsh  → ${ZDOTDIR:-$HOME}/.zshrc                        export PATH=...
#      bash → ~/.bashrc (Linux); on macOS prefers ~/.bash_profile
#             (login shell), falling back to .bash_login/.profile
#      fish → ~/.config/fish/config.fish                      fish_add_path
#             (built-in ≥ fish 3.2, dedupes on its own)
#      sh   → ~/.profile                                      export PATH=...
#    Any other shell: prints the line to add manually and continues.
#    Idempotency marker shared by all shells: the literal 'HOME/.pi/bin'.
# ---------------------------------------------------------------------------
append_path_entry() {  # <rc-file> <line>
  rc="$1" entry="$2"
  [ -f "$rc" ] || : > "$rc"
  if grep -qF 'HOME/.pi/bin' "$rc"; then
    echo ">> PATH entry for ~/.pi/bin already in $rc — skipping"
  else
    printf '\n# pi (coding agent) — added by pi/install.sh\n%s\n' "$entry" >> "$rc"
    echo ">> Appended PATH entry to $rc"
  fi
}

EXPORT_LINE='export PATH="$HOME/.pi/bin:$PATH"'
FISH_LINE='fish_add_path "$HOME/.pi/bin"'
# $SHELL first (the login shell); /etc/passwd as fallback, in two steps —
# deeply nested quoting inside $() breaks dash's parser.
LOGIN_SHELL="$(awk -F: -v u="$(id -u)" '$3==u {print $7; exit}' /etc/passwd 2>/dev/null)"
SHELL_NAME="$(basename "${SHELL:-$LOGIN_SHELL}")"
case "$SHELL_NAME" in
  *zsh)
    append_path_entry "${ZDOTDIR:-$HOME}/.zshrc" "$EXPORT_LINE"
    ;;
  *bash)
    if [ "$(uname -s)" = "Darwin" ]; then
      if   [ -f "$HOME/.bash_profile" ]; then BRC="$HOME/.bash_profile"
      elif [ -f "$HOME/.bash_login" ];   then BRC="$HOME/.bash_login"
      elif [ -f "$HOME/.profile" ];     then BRC="$HOME/.profile"
      else BRC="$HOME/.bash_profile"
      fi
    else
      BRC="$HOME/.bashrc"
    fi
    append_path_entry "$BRC" "$EXPORT_LINE"
    ;;
  *fish)
    FISH_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/fish"
    mkdir -p "$FISH_DIR"
    append_path_entry "$FISH_DIR/config.fish" "$FISH_LINE"
    ;;
  sh|dash|ash)
    append_path_entry "$HOME/.profile" "$EXPORT_LINE"
    ;;
  "")
    echo ">> WARNING: could not detect your shell — add this to its rc file manually:" >&2
    echo ">>   $EXPORT_LINE" >&2
    ;;
  *)
    echo ">> WARNING: unsupported shell '$SHELL_NAME' — add this to its rc file manually:" >&2
    echo ">>   $EXPORT_LINE" >&2
    ;;
esac

# ---------------------------------------------------------------------------
# 10. eden-memory (ATP) identity config — ALWAYS check for config that isn't
#     set and get the user to set it. Sources the installed skill helper: on
#     a terminal it walks through interactive setup (eden_setup) and persists
#     missing values to ~/.eden-memory/.env; without a terminal it prints the
#     exact fix commands. Never aborts the install — it informs.
# ---------------------------------------------------------------------------
EDEN_SKILL="$PI_AGENT/skills/agentic-team-protocol/eden.sh"
if command -v bash >/dev/null 2>&1 && [ -f "$EDEN_SKILL" ]; then
  echo ">> Checking eden-memory (ATP) identity config"
  if bash -c "source '$EDEN_SKILL'"; then
    echo ">> eden-memory identity config OK"
  else
    echo ">> WARNING: eden-memory identity config is incomplete — ATP skills will fail" >&2
    echo ">> until EDEN_ORG_ID is set. Follow the fix commands printed above, or re-run" >&2
    echo ">> ./install.sh in an interactive terminal to be walked through setup." >&2
  fi
else
  echo ">> Skipping eden-memory config check (bash or $EDEN_SKILL not found)"
fi

if [ -n "$pi_shadow_fixed" ] || [ -n "$pi_leftover" ]; then
  echo ""
  echo "NOTE: shells opened BEFORE this run may still resolve an old 'pi'."
  echo "Run 'hash -r' (bash/zsh) or open a new terminal so \$PATH picks up $PI_BIN."
fi
echo ""
echo "Done. ~/.pi recreated."
echo "Next: run 'pi login' (or edit ~/.pi/agent/models.json) to populate credentials,"
echo "then start a new shell so \$PATH includes ~/.pi/bin."