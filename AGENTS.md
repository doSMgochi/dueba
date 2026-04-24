# Codex Working Rules

- All source files that contain Korean or other non-ASCII text must be preserved as UTF-8.
- Never rewrite text-heavy source files with PowerShell commands like `Set-Content`, `Out-File`, or any command that may silently change encoding.
- For manual edits, prefer `apply_patch`.
- If scripted file edits are unavoidable, use an explicit UTF-8 read/write path and verify the file still decodes as UTF-8 after the edit.
- After touching asset paths or localized strings, verify that no mojibake or replacement characters were introduced.
