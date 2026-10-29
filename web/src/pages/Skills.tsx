import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { BookOpen, Check, CheckCircle2, Circle, FileCode2, Plus, Trash2 } from 'lucide-react';
import { Button, Empty, EmptyState, Field, useToast, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { useAgents, useCan, useSkills } from '../lib/queries';
import { AgentIcon } from '../components/AgentIcon';
import type { FileEntry, Skill } from '../lib/types';
import { t } from '../lib/i18n';

const TEMPLATE = t('Quando usar: …\n\nPassos:\n1. …\n');

export function SkillsPage() {
  const { data: skills = [] } = useSkills();
  const canCreate = useCan('skill.create');
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const current = selected === 'new' ? null : skills.find((s) => s.id === selected) ?? null;
  useEffect(() => {
    if (selected === null && skills.length) setSelected(skills[0].id);
  }, [skills, selected]);

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className={clsx('shrink-0 border-line md:w-72 md:border-r', selected && 'hidden md:block')}>
        <div className="flex items-center gap-2 p-4 pb-2">
          <h1 className="text-lg font-semibold">{t('Skills')}</h1>
          {canCreate && <Button size="sm" variant="primary" className="ml-auto" onClick={() => setSelected('new')}><Plus className="size-3.5" /> {t('New')}</Button>}
        </div>
        <p className="px-4 pb-3 text-xs text-mute">{t('Reusable instructions and scripts. Index skills on agents: every agent ships with its bundle of skills. Edit here and it applies everywhere.')}</p>
        <div className="space-y-0.5 px-2 pb-4">
          {skills.map((s) => (
            <button key={s.id} onClick={() => setSelected(s.id)} className={clsx('w-full rounded-md px-2.5 py-2 text-left hover:bg-hover', selected === s.id && 'bg-hover')}>
              <div className="flex items-center gap-2 font-medium">{s.name} {s.always && <span className="rounded bg-accent/15 px-1.5 text-[10px] text-accent">{t('always')}</span>}</div>
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
  // Link: every issue (any agent), chosen agents or none yet.
  const linked = agents.filter((a) => skill && a.skillIds.includes(skill.id)).map((a) => a.id);
  const [scope, setScope] = useState<'all' | 'agents' | 'none'>(skill?.always ? 'all' : linked.length ? 'agents' : 'none');
  const [agentIds, setAgentIds] = useState<string[] | null>(null);
  const chosen = agentIds ?? linked;
  // The agents arrive later: if the skill was already linked to one, it shows that.
  useEffect(() => {
    if (agentIds === null && scope === 'none' && linked.length) setScope('agents');
  }, [linked.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: Partial<Skill>) => setS((x) => ({ ...x, ...p }));
  const setFile = (i: number, p: Partial<FileEntry>) => set({ files: files.map((f, j) => (j === i ? { ...f, ...p } : f)) });

  const save = async () => {
    setBusy(true);
    try {
      const body = { ...s, always: scope === 'all' };
      const saved = s.id ? await api.put<Skill>(`/skills/${s.id}`, body) : await api.post<Skill>('/skills', body);
      await api.put(`/skills/${saved.id}/agents`, { agentIds: scope === 'agents' ? chosen : [] });
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
    <div className="page space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="text-xs text-mute md:hidden">{t('← Skills')}</button>
        <span className="font-mono text-xs text-mute">{s.slug ? `skills/${s.slug}/SKILL.md` : t('new skill')}</span>
        <div className="ml-auto flex gap-2">
          {s.id && canDelete && <Button size="sm" variant="ghost" onClick={remove}><Trash2 className="size-3.5" /> {t('Delete')}</Button>}
          {canSave && <Button size="sm" variant="primary" loading={busy} onClick={save}>{t('Save')}</Button>}
        </div>
      </div>
      {/* Without permission to save: the skill shows read-only. */}
      <fieldset disabled={!canSave} className="contents">
      <Field label={t('Name')}><input className="field-input" autoFocus={!s.id} value={s.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder={t('deploy-staging, commit-style…')} /></Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-dim">{t('Link to')} <span className="font-normal text-mute">{t('· a skill is an instruction; it goes along on every run of whatever is linked')}</span></span>
        <div className="grid gap-2 sm:grid-cols-3">
          {([['all', t('Every issue'), t('Any agent, on any issue')], ['agents', t('Chosen agents'), t('Only when these agents run')], ['none', t('None for now'), t('Kept to link later')]] as const).map(([id, title, desc]) => (
            <button key={id} type="button" onClick={() => setScope(id)}
              className={clsx('rounded-xl border p-3 text-left transition', scope === id ? 'border-accent/60 bg-accent/10' : 'border-line bg-white/[0.02] hover:border-white/15')}>
              <div className="flex items-center gap-1.5 text-[13px] font-medium">{scope === id ? <CheckCircle2 className="size-3.5 text-accent" /> : <Circle className="size-3.5 text-mute" />} {title}</div>
              <div className="mt-0.5 text-[11px] text-mute">{desc}</div>
            </button>
          ))}
        </div>
        {scope === 'agents' && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {agents.map((a) => {
              const on = chosen.includes(a.id);
              return (
                <button key={a.id} type="button" onClick={() => setAgentIds(on ? chosen.filter((x) => x !== a.id) : [...chosen, a.id])}
                  className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition', on ? 'border-accent/50 bg-accent/15 text-fg' : 'border-line text-dim hover:bg-hover')}>
                  <AgentIcon avatar={a.avatar} size={14} /> {a.name} {on && <Check className="size-3 text-accent" />}
                </button>
              );
            })}
            {!agents.length && <span className="text-xs text-mute">{t('No agents created yet.')}</span>}
          </div>
        )}
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
          <button onClick={() => { set({ files: [...files, { path: `script${files.length + 1}.sh`, content: '#!/usr/bin/env bash\nset -euo pipefail\n' }] }); setFileIdx(files.length); }} className="ml-auto rounded p-1 text-mute hover:bg-hover hover:text-fg"><Plus className="size-3.5" /></button>
        </div>
        <div className="space-y-1">
          {files.map((f, i) => (
            <div key={i} className="rounded-md border border-line">
              <div className="flex items-center gap-2 px-2 py-1">
                <FileCode2 className="size-3.5 text-mute" />
                <input value={f.path} onChange={(e) => setFile(i, { path: e.target.value })} className="flex-1 font-mono text-xs" />
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
