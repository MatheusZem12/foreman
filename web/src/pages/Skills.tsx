import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { FileCode2, Plus, Trash2 } from 'lucide-react';
import { Button, Empty, Field, Toggle, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useCan, useSkills } from '../lib/queries';
import type { FileEntry, Skill } from '../lib/types';

const TEMPLATE = `Quando usar: …

Passos:
1. …
`;

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
          <h1 className="text-lg font-semibold">Skills</h1>
          {canCreate && <Button size="sm" variant="primary" className="ml-auto" onClick={() => setSelected('new')}><Plus className="size-3.5" /> Nova</Button>}
        </div>
        <p className="px-4 pb-3 text-xs text-mute">Instruções e scripts reutilizáveis. Indexe as skills nos agentes: todo agente já sai com o seu pacote de skills. Editou aqui, vale para todos.</p>
        <div className="space-y-0.5 px-2 pb-4">
          {skills.map((s) => (
            <button key={s.id} onClick={() => setSelected(s.id)} className={clsx('w-full rounded-md px-2.5 py-2 text-left hover:bg-hover', selected === s.id && 'bg-hover')}>
              <div className="flex items-center gap-2 font-medium">{s.name} {s.always && <span className="rounded bg-accent/15 px-1.5 text-[10px] text-accent">sempre</span>}</div>
              <div className="line-clamp-2 text-xs text-mute">{s.description}</div>
            </button>
          ))}
          {!skills.length && <Empty className="py-6">Nenhuma skill.</Empty>}
        </div>
      </aside>
      <div className={clsx('min-w-0 flex-1 overflow-y-auto', !selected && 'hidden md:block')}>
        {selected ? <SkillEditor key={selected} skill={current} onDone={(id) => setSelected(id)} onBack={() => setSelected(null)} /> : <Empty>Selecione uma skill.</Empty>}
      </div>
    </div>
  );
}

function SkillEditor({ skill, onDone, onBack }: { skill: Skill | null; onDone: (id: string | null) => void; onBack: () => void }) {
  const [s, setS] = useState<Partial<Skill>>(skill ?? { name: '', description: '', content: TEMPLATE, files: [], always: false });
  const [fileIdx, setFileIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const canSave = useCan(skill ? 'skill.update' : 'skill.create');
  const canDelete = useCan('skill.delete');
  const files = s.files ?? [];
  const set = (p: Partial<Skill>) => setS((x) => ({ ...x, ...p }));
  const setFile = (i: number, p: Partial<FileEntry>) => set({ files: files.map((f, j) => (j === i ? { ...f, ...p } : f)) });

  const save = async () => {
    setBusy(true);
    try {
      const saved = s.id ? await api.put<Skill>(`/skills/${s.id}`, s) : await api.post<Skill>('/skills', s);
      qc.invalidateQueries({ queryKey: ['skills'] });
      toast('success', 'Skill salva');
      onDone(saved.id);
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!s.id || !confirm(`Excluir a skill ${s.name}? Agentes e issues deixam de recebê-la.`)) return;
    await api.del(`/skills/${s.id}`);
    qc.invalidateQueries({ queryKey: ['skills'] });
    onDone(null);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="text-xs text-mute md:hidden">← Skills</button>
        <span className="font-mono text-xs text-mute">{s.slug ? `skills/${s.slug}/SKILL.md` : 'nova skill'}</span>
        <div className="ml-auto flex gap-2">
          {s.id && canDelete && <Button size="sm" variant="ghost" onClick={remove}><Trash2 className="size-3.5" /> Excluir</Button>}
          {canSave && <Button size="sm" variant="primary" loading={busy} onClick={save}>Salvar</Button>}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Field label="Nome"><input className="field-input" autoFocus={!s.id} value={s.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder="deploy-hmg, padrao-de-commits…" /></Field>
        <div className="flex items-end pb-1.5"><Toggle checked={!!s.always} onChange={(always) => set({ always })} label="Anexar a todas as issues" /></div>
      </div>
      <Field label="Descrição" hint="o agente decide pela descrição se deve ler a skill; seja específico">
        <input className="field-input" value={s.description ?? ''} onChange={(e) => set({ description: e.target.value })} placeholder="Como publicar em homologação. Use quando a issue pedir deploy." />
      </Field>
      <Field label="Conteúdo (markdown)">
        <textarea className="field-input min-h-[280px] font-mono text-[12px]" value={s.content ?? ''} onChange={(e) => set({ content: e.target.value })} spellCheck={false} />
      </Field>
      <div>
        <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-dim">
          Arquivos da skill <span className="font-normal text-mute">· scripts ficam ao lado do SKILL.md; comece com #! para ficar executável</span>
          <button onClick={() => { set({ files: [...files, { path: `script${files.length + 1}.sh`, content: '#!/usr/bin/env bash\nset -euo pipefail\n' }] }); setFileIdx(files.length); }} className="ml-auto rounded p-1 text-mute hover:bg-hover hover:text-fg"><Plus className="size-3.5" /></button>
        </div>
        <div className="space-y-1">
          {files.map((f, i) => (
            <div key={i} className="rounded-md border border-line">
              <div className="flex items-center gap-2 px-2 py-1">
                <FileCode2 className="size-3.5 text-mute" />
                <input value={f.path} onChange={(e) => setFile(i, { path: e.target.value })} className="flex-1 font-mono text-xs" />
                <button onClick={() => setFileIdx(fileIdx === i ? null : i)} className="text-xs text-mute hover:text-fg">{fileIdx === i ? 'fechar' : 'editar'}</button>
                <button onClick={() => set({ files: files.filter((_, j) => j !== i) })} className="text-mute hover:text-red-400"><Trash2 className="size-3.5" /></button>
              </div>
              {fileIdx === i && <textarea value={f.content} onChange={(e) => setFile(i, { content: e.target.value })} rows={10} spellCheck={false} className="w-full border-t border-line bg-bg p-2 font-mono text-[12px]" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
