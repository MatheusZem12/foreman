import { useEffect, useRef, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, BookOpen, Check, FileCode2, Plus, Trash2 } from 'lucide-react';
import { Button, Empty, EmptyState, Field, useToast, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { useAgents, useCan, useSkills, useWorkspaces } from '../lib/queries';
import { WsBadge, useWs } from '../components/Layout';
import { AgentIcon } from '../components/AgentIcon';
import type { FileEntry, Label, Skill } from '../lib/types';
import { t } from '../lib/i18n';

const TEMPLATE = t('When to use: …\n\nSteps:\n1. …\n');

export function SkillsPage() {
  const { data: skills = [] } = useSkills();
  const canCreate = useCan('skill.create');
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const current = selected === 'new' ? null : skills.find((s) => s.id === selected) ?? null;
  // On a desktop (list and editor side by side) the first skill opens by itself, once.
  // On a phone the list is the first screen, and "back" returns to it.
  const auto = useRef(false);
  useEffect(() => {
    if (auto.current || !skills.length) return;
    auto.current = true;
    if (selected === null && window.matchMedia('(min-width: 768px)').matches) setSelected(skills[0].id);
  }, [skills, selected]);

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className={clsx('min-h-0 overflow-y-auto border-line max-md:flex-1 md:w-72 md:shrink-0 md:border-r', selected && 'hidden md:block')}>
        <div className="flex items-center gap-2 px-4 pb-2 pt-5 md:pt-8">
          <h1 className="text-lg font-semibold tracking-tight">{t('Skills')}</h1>
          {canCreate && <Button size="sm" variant="primary" className="ml-auto" onClick={() => setSelected('new')}><Plus className="size-3.5" /> {t('New')}</Button>}
        </div>
        <p className="px-4 pb-3 text-xs leading-relaxed text-mute">{t('Instructions and scripts for the agents. Link each one by agent, workspace or label: it goes along on every run that matches. Edit here and it applies everywhere.')}</p>
        <div className="space-y-0.5 px-2 pb-4">
          {skills.map((s) => (
            <button key={s.id} onClick={() => setSelected(s.id)} className={clsx('w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-hover', selected === s.id && 'bg-hover')}>
              <div className="flex items-center gap-2 font-medium"><span className="truncate">{s.name}</span> <LinkBadges s={s} /></div>
              <div className="line-clamp-2 text-xs text-mute">{s.description}</div>
            </button>
          ))}
          {!skills.length && <Empty className="mx-2 rounded-xl border border-dashed border-line py-8 text-xs">{t('No skills yet. Skills are guides and scripts you index on agents.')}</Empty>}
        </div>
      </aside>
      <div className={clsx('min-w-0 flex-1 overflow-y-auto', !selected && 'hidden md:block')}>
        {selected ? <SkillEditor key={selected} skill={current} onDone={(id) => setSelected(id)} onBack={() => setSelected(null)} /> : <div className="p-6"><EmptyState icon={BookOpen} title={skills.length ? t('Select a skill') : t('No skills yet')} action={canCreate && <Button variant="primary" onClick={() => setSelected('new')}><Plus className="size-4" /> {t('New skill')}</Button>}>{t('Reusable instructions and scripts. Index them on agents: call the agent and its bundle of skills goes along.')}</EmptyState></div>}
      </div>
    </div>
  );
}

function LinkGroup({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const has = Array.isArray(children) ? children.flat().length > 0 : !!children;
  return (
    <div>
      <div className="label-caps mb-1.5">{title}</div>
      <div className="flex flex-wrap gap-1.5">{has ? children : <span className="text-xs text-mute">{empty}</span>}</div>
    </div>
  );
}

// Where a skill goes, in short, for the list.
function LinkBadges({ s }: { s: Skill }) {
  const { data: agents = [] } = useAgents();
  const nAgents = agents.filter((a) => a.skillIds.includes(s.id)).length;
  const parts = [
    nAgents && t('{0} agent(s)', nAgents),
    s.workspaceIds?.length && t('{0} workspace(s)', s.workspaceIds.length),
    s.labelIds?.length && t('{0} label(s)', s.labelIds.length)
  ].filter(Boolean) as string[];
  if (s.always) parts.unshift(t('always'));
  return parts.length
    ? <span className="badge shrink-0 py-0 text-[10px]">{parts.join(' · ')}</span>
    : <span className="badge shrink-0 bg-amber-400/10 py-0 text-[10px] text-amber-400">{t('not linked')}</span>;
}

function SkillEditor({ skill, onDone, onBack }: { skill: Skill | null; onDone: (id: string | null) => void; onBack: () => void }) {
  const ask = useConfirm();
  const [s, setS] = useState<Partial<Skill>>(skill ?? { name: '', description: '', content: TEMPLATE, files: [], always: false });
  const [fileIdx, setFileIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const canSave = useCan(skill ? 'skill.update' : 'skill.create');
  const canDelete = useCan('skill.delete');
  const files = s.files ?? [];
  const { data: agents = [] } = useAgents();
  const { data: workspaces = [] } = useWorkspaces();
  const { ws } = useWs();
  // Links (any match sends the skill): agents, workspaces and labels. A new skill starts
  // tied to the workspace you are in.
  const linked = agents.filter((a) => skill && a.skillIds.includes(skill.id)).map((a) => a.id);
  const [agentIds, setAgentIds] = useState<string[] | null>(null);
  const chosen = agentIds ?? linked;
  const [wsIds, setWsIds] = useState<string[]>(skill ? skill.workspaceIds ?? [] : [ws.id]);
  const [labelIds, setLabelIds] = useState<string[]>(skill?.labelIds ?? []);
  const labelGroups = useQueries({
    queries: workspaces.map((w) => ({ queryKey: ['labels', w.id], queryFn: () => api.get<Label[]>(`/workspaces/${w.id}/labels`) }))
  }).map((q, i) => ({ ws: workspaces[i], labels: q.data ?? [] })).filter((g) => g.labels.length);
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const nothing = !chosen.length && !wsIds.length && !labelIds.length && !skill?.always;
  const set = (p: Partial<Skill>) => setS((x) => ({ ...x, ...p }));
  const setFile = (i: number, p: Partial<FileEntry>) => set({ files: files.map((f, j) => (j === i ? { ...f, ...p } : f)) });

  const save = async () => {
    setBusy(true);
    try {
      const body = { ...s, always: false, workspaceIds: wsIds, labelIds };
      const saved = s.id ? await api.put<Skill>(`/skills/${s.id}`, body) : await api.post<Skill>('/skills', body);
      await api.put(`/skills/${saved.id}/agents`, { agentIds: chosen });
      qc.invalidateQueries({ queryKey: ['skills'] });
      qc.invalidateQueries({ queryKey: ['agents'] });
      toast('success', t('Skill saved'));
      onDone(saved.id);
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!s.id || !(await ask({ title: t('Delete the skill {0}?', s.name), message: t('Agents and issues stop receiving it.'), confirmText: t('Delete'), danger: true }))) return;
    await api.del(`/skills/${s.id}`);
    qc.invalidateQueries({ queryKey: ['skills'] });
    onDone(null);
  };

  return (
    <div className="page page-narrow space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onBack} className="-ml-1 inline-flex h-8 items-center rounded-lg px-2 text-xs text-dim hover:bg-hover md:hidden">{t('← Skills')}</button>
        <span className="min-w-0 truncate font-mono text-xs text-mute">{s.slug ? `skills/${s.slug}/SKILL.md` : t('new skill')}</span>
        <div className="ml-auto flex gap-2">
          {s.id && canDelete && <Button size="sm" variant="ghost" onClick={remove}><Trash2 className="size-3.5" /> {t('Delete')}</Button>}
          {canSave && <Button size="sm" variant="primary" loading={busy} onClick={save}>{t('Save')}</Button>}
        </div>
      </div>
      {/* Without permission to save: the skill shows read-only. */}
      <fieldset disabled={!canSave} className="contents">
      <Field label={t('Name')}><input className="field-input" autoFocus={!s.id} value={s.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder={t('deploy-staging, commit-style…')} /></Field>
      <div className="flex flex-col gap-3">
        <div>
          <span className="text-xs font-medium text-dim">{t('Link to')}</span>
          <p className="mt-0.5 text-[11px] leading-relaxed text-mute">{t('The skill goes along on every run that matches any of these: the issue\'s agent, its workspace or one of its labels.')}</p>
        </div>
        <LinkGroup title={t('Agents')} empty={t('No agents created yet.')}>
          {agents.map((a) => (
            <button key={a.id} type="button" aria-pressed={chosen.includes(a.id)} onClick={() => setAgentIds(toggle(chosen, a.id))} className="pill">
              <AgentIcon avatar={a.avatar} size={14} /> {a.name} {chosen.includes(a.id) && <Check className="size-3 text-accent" />}
            </button>
          ))}
        </LinkGroup>
        <LinkGroup title={t('Workspaces')} empty={t('No workspaces created yet.')}>
          {workspaces.map((w) => (
            <button key={w.id} type="button" aria-pressed={wsIds.includes(w.id)} onClick={() => setWsIds(toggle(wsIds, w.id))} className="pill">
              <WsBadge name={w.name} muted={!wsIds.includes(w.id)} /> {w.name} {wsIds.includes(w.id) && <Check className="size-3 text-accent" />}
            </button>
          ))}
        </LinkGroup>
        <LinkGroup title={t('Labels')} empty={t('No labels yet')}>
          {labelGroups.map((g) => g.labels.map((l) => (
            <button key={l.id} type="button" aria-pressed={labelIds.includes(l.id)} onClick={() => setLabelIds(toggle(labelIds, l.id))} className="pill" title={g.ws.name}>
              <span className="size-2 rounded-full" style={{ background: l.color }} /> {l.name}
              {workspaces.length > 1 && <span className="text-mute">· {g.ws.key}</span>}
              {labelIds.includes(l.id) && <Check className="size-3 text-accent" />}
            </button>
          )))}
        </LinkGroup>
        {nothing && <div className="callout"><AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-400" /> {t('Not linked to anything: this skill isn\'t sent on any run.')}</div>}
      </div>
      <Field label={t('Description')} hint={t('the agent uses the description to decide whether to read the skill; be specific')}>
        <input className="field-input" value={s.description ?? ''} onChange={(e) => set({ description: e.target.value })} placeholder={t('How to deploy to staging. Use when the issue asks for a deploy.')} />
      </Field>
      <Field label={t('Content (markdown)')}>
        <textarea className="field-input min-h-[280px] font-mono text-[12px]" value={s.content ?? ''} onChange={(e) => set({ content: e.target.value })} spellCheck={false} />
      </Field>
      <div>
        <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-dim">
          {t('Skill files')} <span className="font-normal text-mute">{t('· scripts sit next to SKILL.md; start with #! to make them executable')}</span>
          <button onClick={() => { set({ files: [...files, { path: `script${files.length + 1}.sh`, content: '#!/usr/bin/env bash\nset -euo pipefail\n' }] }); setFileIdx(files.length); }} aria-label={t('Add')} className="icon-btn ml-auto size-7"><Plus className="size-3.5" /></button>
        </div>
        <div className="space-y-1">
          {files.map((f, i) => (
            <div key={i} className="overflow-hidden rounded-lg border border-line">
              <div className="flex items-center gap-2 px-2.5 py-1.5">
                <FileCode2 className="size-3.5 text-mute" />
                <input value={f.path} onChange={(e) => setFile(i, { path: e.target.value })} className="min-w-0 flex-1 font-mono text-xs" />
                <button onClick={() => setFileIdx(fileIdx === i ? null : i)} className="text-xs text-mute hover:text-fg">{fileIdx === i ? t('close') : t('edit')}</button>
                <button onClick={() => set({ files: files.filter((_, j) => j !== i) })} className="text-mute hover:text-red-400"><Trash2 className="size-3.5" /></button>
              </div>
              {fileIdx === i && <textarea value={f.content} onChange={(e) => setFile(i, { content: e.target.value })} rows={10} spellCheck={false} className="w-full border-t border-line bg-bg p-2 font-mono text-[12px]" />}
            </div>
          ))}
        </div>
      </div>
      </fieldset>
    </div>
  );
}
