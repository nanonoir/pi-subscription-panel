# Manual Atelier interaction spike

This test uses **fictional quota data**, not your subscription readings. It proves
only the owner-approved command/menu interaction for the Phase 4 feasibility gate.
Production adapters, preferences, polling, and the panel entry point are not loaded
by this fixture. No clickable-heading behavior is claimed.

## Launch from the repository checkout

Use a separate terminal and the existing Pi/Atelier installation. In PowerShell:

```powershell
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.pi/agent' }
$atelier = Join-Path $agentDir 'npm/node_modules/pi-atelier/extensions/index.ts'
if (-not (Test-Path $atelier)) { throw 'Locate your existing Atelier extension; do not install a replacement for this test.' }
pi --no-extensions --no-mcp --no-skills --no-context-files -e $atelier -e ./test/manual/atelier-interaction.ts
```

Explicit `-e` paths remain enabled with `--no-extensions`. This prevents loading
the configured original subscription panel or other provider extensions alongside
the fixture. `--no-mcp` prevents built-in MCP connections. Pi/Atelier can still do
their own normal startup work; the fixture itself makes no provider/network/CLI
requests. **Do not send a prompt, change models, or sign in for this test.** If Pi
cannot open without an authentication/model change, stop and report that blocker.

The command uses your existing npm-installed Atelier host (0.18.0 in the discovery
record), not a replacement. If you installed Atelier elsewhere, substitute only
that existing host's entry-point path. No `pi install` or global config edit is needed.

## Observe the interaction

1. Open Atelier Display (F6 → Settings → Display, or `/atelier display`). Note the
   current layout so any manual edits can be restored. Enable only the three new
   **TEST** provider panels; their IDs start with `subscription-spike:`. Do not
   confuse them with real subscription data or change existing provider panels.
2. Confirm Codex, Claude Code, and Antigravity test headings/details are visible
   together in the right sidebar. Looking at them requires no test command.
3. Run `/subscriptions-spike`, choose Claude Code, and confirm only its details
   collapse. Its heading and concise quota summary must remain visible; the other
   two panels must not change.
4. Run `/subscriptions-spike toggle claude-code` to restore its details. Canceling
   the menu or supplying an invalid provider must not alter any panel.
5. Narrow/widen the terminal and verify readable host-managed truncation. Check
   Display hide/reorder still works, then restore the original layout and hide the
   three TEST panels before exiting. The fixture does not persist expansion state.

## Report back

Confirm host version, whether all three panels appeared, whether independent
collapse/expand preserved headings/summaries, and any errors or narrow-layout
issues. Do not share credentials, account IDs, private prompts, or raw CLI output.

**Status: awaiting actual TUI observation.** Mock tests and typechecking do not
satisfy this gate. Preference persistence, real provider freshness, and production
integration require later implementation and validation after this interaction proof.
