-- Gemini CLI joins Claude Code and Codex as an agent runtime.
alter table agents drop constraint if exists agents_runtime_check;
alter table agents add constraint agents_runtime_check check (runtime in ('claude', 'codex', 'gemini'));
