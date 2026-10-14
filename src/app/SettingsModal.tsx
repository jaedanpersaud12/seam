import { ask, message } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { LoadingButton } from "../components/interior/loading-button";
import { Modal } from "../components/interior/modal";
import { SegmentedControl } from "../components/interior/segmented-control";
import { ipc } from "../lib/ipc";
import { Toggle } from "./DiffRules";
import { useSettings, type Settings } from "./settings";

/** Installs ~/.local/bin/seam, then offers (and asks before) registering it with git. */
export async function installCommandLineTool() {
  const r = await ipc.installCli();
  const git = await ask(
    `Installed ${r.link}.${r.onPath ? "" : "\n\n~/.local/bin isn't on your PATH yet; add it in your shell profile."}\n\nAlso make Seam git's difftool? This sets diff.tool, difftool.seam.cmd and difftool.prompt in your global git config.`,
    { title: "Command line tool installed", kind: "info", okLabel: "Set as difftool", cancelLabel: "Not now" },
  );
  if (git) {
    await ipc.configureGit();
    await message("Run `git difftool` to compare with Seam.", { title: "Git configured" });
  }
}

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSettings();
  const [excludes, setExcludes] = useState(s.excludes.join(", "));

  return (
    <Modal open={open} onClose={onClose} title="Settings" maxWidth={480}>
      <div className="space-y-5">
        <Row label="Appearance">
          <SegmentedControl
            label="Appearance"
            value={s.theme}
            onValueChange={(v) => s.update({ theme: v as Settings["theme"] })}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </Row>
        <Row label="Diff colours" hint="Colour-blind safe uses blue, orange and purple.">
          <SegmentedControl
            label="Diff colours"
            value={s.palette}
            onValueChange={(v) => s.update({ palette: v as Settings["palette"] })}
            options={[
              { value: "classic", label: "Classic" },
              { value: "cb", label: "Colour-blind safe" },
            ]}
          />
        </Row>
        <Row label="Code size">
          <SegmentedControl
            label="Code size"
            value={String(s.fontSize)}
            onValueChange={(v) => s.update({ fontSize: Number(v) })}
            options={["11.5", "12.5", "13.5", "15"].map((v) => ({ value: v, label: `${v}px` }))}
          />
        </Row>
        <Row label="Folder comparison" hint="Names to skip anywhere in the tree, separated by commas.">
          <input
            value={excludes}
            onChange={(e) => setExcludes(e.target.value)}
            onBlur={() => s.update({ excludes: excludes.split(",").map((x) => x.trim()).filter(Boolean) })}
            className="h-8 w-full rounded-[6px] border border-ink-200 bg-surface px-2.5 font-mono text-[12px] text-ink-800 outline-none focus:border-accent focus:shadow-control-focus"
            spellCheck={false}
          />
          <div className="mt-2">
            <Toggle label="Respect .gitignore" checked={s.respectGitignore} onChange={(v) => s.update({ respectGitignore: v })} />
          </div>
        </Row>
        <Row label="Command line" hint="Adds `seam <left> <right>` and can register it as git's difftool.">
          <LoadingButton onAction={installCommandLineTool} pendingLabel="Installing" successLabel="Installed">
            Install command line tool
          </LoadingButton>
        </Row>
      </div>
    </Modal>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[12px] font-medium text-ink-700">{label}</div>
      {children}
      {hint && <div className="mt-1.5 text-[11.5px] text-ink-500">{hint}</div>}
    </div>
  );
}
