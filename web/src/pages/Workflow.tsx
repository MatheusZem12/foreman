import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  AlertTriangle, ArrowRightLeft, Bot, GitMerge, GitPullRequest, Mail, Pencil, Plus, Sparkles, SquareTerminal, Trash2, Webhook, Workflow, Zap
} from 'lucide-react';
import { useWs } from '../components/Layout';
import { Button, Field, Modal, PageHeader, StatusIcon, Toggle, useToast } from '../components/ui';
import { AgentIcon } from '../components/AgentIcon';
import { api } from '../lib/api';
import { statusOf } from '../lib/constants';
import { useAgents, useRules, useStages } from '../lib/queries';
import type { Rule, RuleAction, RuleConfig, Stage } from '../lib/types';

// O que cada etapa do sistema já faz sozinha.
const BUILTIN: Record<string, string> = {
  backlog: 'Ideias e tarefas que ainda não rodam.',
  todo: 'Com agente, a issue entra na fila na hora.',
  in_progress: 'O agente está trabalhando. Todo pedido novo (issue, ajuste, regra) vem para cá.',
  waiting: 'A IA parou e precisa de alguém: decisão, acesso, dado ou confirmação.',
  in_review: 'A IA terminou. Revise e aprove com ✓ para ir a Concluída.',
  blocked: 'A execução falhou ou o merge deu conflito.',
  done: 'Aprovada.',
  cancelled: 'Interrompida; a execução em andamento para.'
};

const ACTIONS: { id: RuleAction; icon: typeof Mail; label: string; desc: string }[] = [
  { id: 'notify', icon: Mail, label: 'Notificar por e-mail', desc: 'Quem pediu, quem criou, o workspace ou e-mails escolhidos.' },
  { id: 'webhook', icon: Webhook, label: 'Webhook', desc: 'POST com JSON; funciona com Slack, Discord, Teams, n8n…' },
  { id: 'move', icon: ArrowRightLeft, label: 'Mover para etapa', desc: 'Encaminha a issue para outra etapa.' },
  { id: 'run_agent', icon: Bot, label: 'Rodar agente', desc: 'Pede algo a um agente (ex.: revisão por IA, testes).' },
  { id: 'open_pr', icon: GitPullRequest, label: 'Abrir pull request', desc: 'Um PR por repositório alterado (GitHub, via gh).' },
  { id: 'merge', icon: GitMerge, label: 'Fazer merge', desc: 'Na branch de destino da issue ou numa fixa.' },
  { id: 'script', icon: SquareTerminal, label: 'Rodar script', desc: 'Bash na pasta da issue, com variáveis MULTICA_*.' }
];
const actionOf = (id: RuleAction) => ACTIONS.find((a) => a.id === id)!;

const WHO: Record<string, string> = { requester: 'quem pediu', author: 'quem criou a issue', workspace: 'todo o workspace', emails: 'e-mails escolhidos' };

// Modelos prontos: um clique cria a regra já configurada.
const PRESETS: { label: string; stage: string; action: RuleAction; config: RuleConfig }[] = [
  { label: 'Avisar o time quando chegar em revisão', stage: 'in_review', action: 'notify', config: { to: 'workspace' } },
  { label: 'Avisar quem pediu quando bloquear', stage: 'blocked', action: 'notify', config: { to: 'requester' } },
  { label: 'Abrir PR ao concluir', stage: 'done', action: 'open_pr', config: {} },
  { label: 'Webhook do Slack/Discord em revisão', stage: 'in_review', action: 'webhook', config: { url: '' } }
];

export function WorkflowPage() {
  const { ws } = useWs();
  const { data: stages = [] } = useStages(ws.id);
  const { data: rules = [] } = useRules(ws.id);
  const { data: agents = [] } = useAgents();
  const { data: email } = useQuery({ queryKey: ['email-settings'], queryFn: () => api.get<{ enabled: boolean }>('/settings/email') });
  const [editingRule, setEditingRule] = useState<Partial<Rule> | null>(null);
  const [editingStage, setEditingStage] = useState<Partial<Stage> & { after?: string } | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['rules', ws.id] });
    qc.invalidateQueries({ queryKey: ['stages', ws.id] });
  };
  const toggle = async (r: Rule) => {
    try {
      await api.put(`/rules/${r.id}`, { ...r, enabled: !r.enabled });
      refresh();
    } catch (err) {
      toast('error', (err as Error).message);
    }
  };
  const remove = async (r: Rule) => {
    if (!confirm('Remover esta regra?')) return;
    await api.del(`/rules/${r.id}`);
    refresh();
  };
  const removeStage = async (s: Stage) => {
    if (!confirm(`Remover a etapa "${s.name}"? As issues dela voltam para o Backlog e as regras dela são apagadas.`)) return;
    await api.del(`/stages/${s.id}`);
    refresh();
    qc.invalidateQueries({ queryKey: ['issues', ws.id] });
  };

  const summary = (r: Rule) => {
    const c = r.config ?? {};
    const stageName = (id?: string) => (id ? stages.find((s) => s.id === id)?.name ?? 'etapa removida' : '');
    switch (r.action) {
      case 'notify': return `E-mail para ${c.to === 'emails' ? c.emails : WHO[c.to ?? 'requester']}`;
      case 'webhook': return `POST ${c.url}`;
      case 'move': return `Mover para ${stageName(c.to)}`;
      case 'run_agent': {
        const a = agents.find((x) => x.id === c.agentId);
        return `${a ? a.name : 'Agente da issue'}${c.request ? `: “${c.request}”` : ''}`;
      }
      case 'open_pr': return `PR para ${c.base || 'a branch de destino da issue'}${c.draft ? ' (rascunho)' : ''}`;
      case 'merge': return `Merge em ${c.base || 'a branch de destino da issue'}`;
      case 'script': return (c.script ?? '').split('\n')[0];
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl p-4 pb-24 md:p-8">
        <PageHeader
          icon={Workflow}
          title="Fluxo e automações"
          description="As etapas do quadro e o que acontece quando uma issue entra em cada uma. As regras rodam na ordem, e cada ação fica registrada na issue."
          actions={<Button variant="primary" onClick={() => setEditingStage({ color: '#a78bfa', after: 'in_review' })}><Plus className="size-4" /> Nova etapa</Button>}
        />

        {email && !email.enabled && rules.some((r) => r.action === 'notify' && r.enabled) && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2.5 text-xs text-amber-200">
            <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-400" />
            O envio de e-mail está desligado no servidor: as regras de notificar não enviam nada até alguém ligar em Servidor → E-mail.
          </div>
        )}
        <div className="mb-6 rounded-2xl border border-white/[0.07] bg-gradient-to-b from-accent/[0.06] to-transparent p-4">
          <div className="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-dim"><Sparkles className="size-3.5 text-accent" /> Modelos prontos</div>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => {
              const A = actionOf(p.action).icon;
              return (
                <button key={p.label} onClick={() => setEditingRule({ stage: p.stage, action: p.action, config: p.config, enabled: true })}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white/[0.02] px-3 py-1.5 text-xs text-dim transition hover:border-accent/40 hover:bg-accent/10 hover:text-fg">
                  <A className="size-3.5" /> {p.label}
                </button>
              );
            })}
          </div>
        </div>

        <ol className="relative space-y-3">
          <div className="absolute bottom-6 left-[19px] top-6 w-px bg-gradient-to-b from-line via-line to-transparent" />
          {stages.map((s) => {
            const list = rules.filter((r) => r.stage === s.id);
            return (
              <li key={s.id} className="relative flex gap-3">
                <span className="relative z-10 mt-3 grid size-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-panel">
                  <StatusIcon status={s.id} className="scale-125" />
                </span>
                <div className="surface min-w-0 flex-1 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{s.name}</span>
                    {s.system ? <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] text-mute">sistema</span>
                      : <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: `${s.color}22`, color: s.color }}>personalizada</span>}
                    <div className="ml-auto flex items-center gap-0.5">
                      {!s.system && <>
                        <button title="Editar etapa" onClick={() => setEditingStage(s)} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-fg"><Pencil className="size-3.5" /></button>
                        <button title="Remover etapa" onClick={() => removeStage(s)} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-red-400"><Trash2 className="size-3.5" /></button>
                      </>}
                      <Button size="sm" variant="ghost" onClick={() => setEditingRule({ stage: s.id, action: 'notify', config: { to: 'requester' }, enabled: true })}>
                        <Plus className="size-3.5" /> Regra
                      </Button>
                    </div>
                  </div>
                  <p className="mt-0.5 text-xs text-mute">{s.system ? BUILTIN[s.id] : 'Etapa sua: sem comportamento próprio; use regras para automatizar.'}</p>
                  {list.length > 0 && (
                    <div className="mt-3 space-y-1.5">
                      {list.map((r) => {
                        const A = actionOf(r.action);
                        return (
                          <div key={r.id} className={clsx('group flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 transition', !r.enabled && 'opacity-50')}>
                            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent"><A.icon className="size-3.5" /></span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 text-[13px]"><Zap className="size-3 text-mute" /><span className="text-mute">ao entrar:</span> <span className="font-medium">{A.label}</span></div>
                              <div className="truncate text-xs text-dim">{summary(r)}</div>
                            </div>
                            <Toggle checked={r.enabled} onChange={() => toggle(r)} />
                            <button onClick={() => setEditingRule(r)} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-fg"><Pencil className="size-3.5" /></button>
                            <button onClick={() => remove(r)} className="rounded-lg p-1.5 text-mute hover:bg-white/5 hover:text-red-400"><Trash2 className="size-3.5" /></button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      {editingRule && <RuleModal rule={editingRule} stages={stages} onClose={() => setEditingRule(null)} onSaved={refresh} />}
      {editingStage && <StageModal stage={editingStage} stages={stages} onClose={() => setEditingStage(null)} onSaved={refresh} />}
    </div>
  );
}

function StageModal({ stage, stages, onClose, onSaved }: { stage: Partial<Stage> & { after?: string }; stages: Stage[]; onClose: () => void; onSaved: () => void }) {
  const { ws } = useWs();
  const [s, setS] = useState(stage);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const COLORS = ['#a78bfa', '#60a5fa', '#22d3ee', '#34d399', '#a3e635', '#fbbf24', '#fb923c', '#f87171', '#f472b6', '#94a3b8'];
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: s.name, color: s.color, after: s.after ?? '' };
      if (s.id) await api.put(`/stages/${s.id}`, body);
      else await api.post(`/workspaces/${ws.id}/stages`, body);
      onSaved();
      onClose();
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={s.id ? `Editar ${stage.name}` : 'Nova etapa'} footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={save}>Salvar</Button></>}>
      <div className="space-y-4">
        <Field label="Nome"><input autoFocus className="field-input" value={s.name ?? ''} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder="Ex.: Revisão por IA, QA, Deploy em homologação" /></Field>
        <Field label={s.id ? 'Mover para depois de' : 'Entra depois de'} hint={s.id ? 'opcional' : undefined}>
          <select className="field-input" value={s.after ?? ''} onChange={(e) => setS({ ...s, after: e.target.value })}>
            {s.id && <option value="">manter a posição</option>}
            {stages.filter((x) => x.id !== s.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-dim">Cor</span>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setS({ ...s, color: c })} style={{ background: c }}
                className={clsx('size-6 rounded-full transition hover:scale-110', s.color === c && 'ring-2 ring-white/80 ring-offset-2 ring-offset-panel')} />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function RuleModal({ rule, stages, onClose, onSaved }: { rule: Partial<Rule>; stages: Stage[]; onClose: () => void; onSaved: () => void }) {
  const { ws } = useWs();
  const { data: agents = [] } = useAgents();
  const [r, setR] = useState<Partial<Rule>>({ ...rule, config: { ...(rule.config ?? {}) } });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const c = r.config ?? {};
  const setC = (p: Partial<RuleConfig>) => setR({ ...r, config: { ...c, ...p } });
  const others = stages.filter((s) => s.id !== r.stage);

  const save = async () => {
    setBusy(true);
    try {
      const body = { stage: r.stage, action: r.action, config: c, enabled: r.enabled ?? true };
      if (r.id) await api.put(`/rules/${r.id}`, body);
      else await api.post(`/workspaces/${ws.id}/rules`, body);
      onSaved();
      onClose();
    } catch (err) {
      toast('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onFail = (
    <Field label="Se falhar, mover para" hint="opcional">
      <select className="field-input" value={c.onFail ?? ''} onChange={(e) => setC({ onFail: e.target.value })}>
        <option value="">não mover (só registrar na issue)</option>
        {others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </Field>
  );

  return (
    <Modal open wide onClose={onClose} title={r.id ? 'Editar regra' : 'Nova regra'}
      footer={<><Toggle checked={r.enabled ?? true} onChange={(enabled) => setR({ ...r, enabled })} label="Ativa" /><span className="flex-1" /><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={save}>Salvar</Button></>}>
      <div className="space-y-5">
        <Field label="Quando a issue entrar em">
          <select className="field-input" value={r.stage} onChange={(e) => setR({ ...r, stage: e.target.value })}>
            {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>

        <div>
          <div className="mb-1.5 text-xs font-medium text-dim">Fazer</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {ACTIONS.map((a) => (
              <button key={a.id} type="button" onClick={() => setR({ ...r, action: a.id, config: a.id === 'notify' ? { to: 'requester' } : {} })}
                className={clsx('flex items-start gap-2.5 rounded-xl border p-3 text-left transition',
                  r.action === a.id ? 'border-accent/60 bg-accent/10' : 'border-line bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]')}>
                <span className={clsx('grid size-8 shrink-0 place-items-center rounded-lg', r.action === a.id ? 'bg-accent/20 text-accent' : 'bg-white/5 text-dim')}><a.icon className="size-4" /></span>
                <span><span className="block text-[13px] font-medium">{a.label}</span><span className="block text-xs leading-snug text-mute">{a.desc}</span></span>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-4 rounded-xl border border-white/[0.06] bg-black/10 p-4">
          {r.action === 'notify' && <>
            <Field label="Para quem">
              <select className="field-input" value={c.to ?? 'requester'} onChange={(e) => setC({ to: e.target.value })}>
                {Object.entries(WHO).map(([k, v]) => <option key={k} value={k}>{v[0].toUpperCase() + v.slice(1)}</option>)}
              </select>
            </Field>
            {c.to === 'emails' && <Field label="E-mails" hint="separados por vírgula"><input className="field-input" value={c.emails ?? ''} onChange={(e) => setC({ emails: e.target.value })} placeholder="time@empresa.com, ana@empresa.com" /></Field>}
            <Field label="Mensagem" hint="opcional"><textarea className="field-input" rows={2} value={c.message ?? ''} onChange={(e) => setC({ message: e.target.value })} placeholder="Ex.: Revisar até o fim do dia." /></Field>
            <p className="text-xs text-mute">Usa o SMTP configurado em Servidor; cai na mesma conversa de e-mail do workspace.</p>
          </>}
          {r.action === 'webhook' && <>
            <Field label="URL"><input className="field-input font-mono text-xs" value={c.url ?? ''} onChange={(e) => setC({ url: e.target.value })} placeholder="https://hooks.slack.com/services/…" /></Field>
            <Field label="Mensagem" hint="opcional; vai no campo message"><input className="field-input" value={c.message ?? ''} onChange={(e) => setC({ message: e.target.value })} /></Field>
            <p className="text-xs text-mute">Envia <code>{'{ ref, title, from, to, stage, branch, text, content }'}</code>. <code>text</code> e <code>content</code> fazem Slack e Discord mostrarem a mensagem direto.</p>
          </>}
          {r.action === 'move' && (
            <Field label="Mover para">
              <select className="field-input" value={c.to ?? ''} onChange={(e) => setC({ to: e.target.value })}>
                <option value="" disabled>escolha a etapa</option>
                {others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          )}
          {r.action === 'run_agent' && <>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-dim">Agente</span>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" onClick={() => setC({ agentId: '' })} className={clsx('rounded-full border px-3 py-1 text-xs', !c.agentId ? 'border-accent/50 bg-accent/15' : 'border-line text-dim hover:bg-hover')}>O da issue</button>
                {agents.map((a) => (
                  <button key={a.id} type="button" onClick={() => setC({ agentId: a.id })}
                    className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs', c.agentId === a.id ? 'border-accent/50 bg-accent/15' : 'border-line text-dim hover:bg-hover')}>
                    <AgentIcon avatar={a.avatar} size={14} /> {a.name}
                  </button>
                ))}
              </div>
            </div>
            <Field label="O que pedir" hint="vazio = executar a issue"><textarea className="field-input" rows={3} value={c.request ?? ''} onChange={(e) => setC({ request: e.target.value })} placeholder="Ex.: Revise o diff, rode os testes e corrija o que quebrar." /></Field>
            <p className="text-xs text-mute">Abre um chat novo com o README da issue como contexto. A issue vai para Em andamento e, ao terminar, segue o resultado que a IA declarar.</p>
          </>}
          {r.action === 'open_pr' && <>
            <Field label="Branch de destino do PR" hint="vazio = a de merge da issue"><input className="field-input font-mono text-xs" value={c.base ?? ''} onChange={(e) => setC({ base: e.target.value })} placeholder="main" /></Field>
            <Toggle checked={!!c.draft} onChange={(draft) => setC({ draft })} label="Abrir como rascunho" />
            <p className="text-xs text-mute">Usa o <code>gh</code> autenticado no servidor; o corpo do PR é o README da issue. Se a regra de merge de Concluída também estiver ativa, desative-a para o PR ser o caminho.</p>
            {onFail}
          </>}
          {r.action === 'merge' && <>
            <Field label="Branch" hint="vazio = a de merge de cada repositório na issue"><input className="field-input font-mono text-xs" value={c.base ?? ''} onChange={(e) => setC({ base: e.target.value })} placeholder="main" /></Field>
            <p className="text-xs text-mute">Tudo ou nada: com conflito em qualquer repositório nada é publicado e a issue vai para Bloqueada.</p>
          </>}
          {r.action === 'script' && <>
            <Field label="Script (bash)">
              <textarea className="field-input font-mono text-xs" rows={6} spellCheck={false} value={c.script ?? ''} onChange={(e) => setC({ script: e.target.value })}
                placeholder={'# roda na pasta da issue (um subdiretório por repositório)\ncurl -X POST https://ci.exemplo.com/deploy -d "branch=$MULTICA_BRANCH"'} />
            </Field>
            <p className="text-xs text-mute">
              Variáveis: <code>MULTICA_ISSUE</code>, <code>MULTICA_TITLE</code>, <code>MULTICA_BRANCH</code>, <code>MULTICA_STAGE</code>, <code>MULTICA_FROM</code>, <code>MULTICA_README</code>, <code>MULTICA_WORKSPACE</code>.
              Limite de 10 minutos; as últimas linhas da saída ficam registradas na issue.
            </p>
            {onFail}
          </>}
        </div>
        {r.stage && <p className="flex items-center gap-1.5 text-xs text-mute"><StatusIcon status={r.stage} /> Dispara sempre que uma issue entra em <b className="text-dim">{statusOf(r.stage).label}</b>, venha de onde vier (quadro, agente ou outra regra).</p>}
      </div>
    </Modal>
  );
}
