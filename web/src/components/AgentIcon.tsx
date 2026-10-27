import clsx from 'clsx';
import {
  Bot, Brain, Bug, Code2, Cpu, Database, Eye, FlaskConical, GitPullRequest, Moon, Palette, Rocket, Search,
  ShieldCheck, Sparkles, Terminal, Wand2, Wrench, Zap, type LucideIcon
} from 'lucide-react';

// O avatar do agente é guardado como "ícone:cor" (ex.: "code:violet").
// Agentes antigos guardavam um emoji; ele é traduzido para o ícone equivalente.
export const AGENT_ICONS: Record<string, LucideIcon> = {
  bot: Bot, sparkles: Sparkles, code: Code2, terminal: Terminal, bug: Bug, test: FlaskConical, wrench: Wrench,
  palette: Palette, search: Search, eye: Eye, review: GitPullRequest, shield: ShieldCheck, rocket: Rocket,
  brain: Brain, zap: Zap, wand: Wand2, cpu: Cpu, database: Database, moon: Moon
};

export const AGENT_COLORS: Record<string, [string, string]> = {
  violet: ['#8b7bff', '#5b45e0'],
  blue: ['#5aa2f5', '#2563eb'],
  sky: ['#4fd1e8', '#0e8fb0'],
  emerald: ['#34d399', '#059669'],
  lime: ['#a3e635', '#4d9a0b'],
  amber: ['#fbbf24', '#d97706'],
  orange: ['#fb923c', '#dd5b13'],
  rose: ['#fb7185', '#e11d48'],
  fuchsia: ['#e879f9', '#a21caf'],
  slate: ['#a1a1aa', '#52525b']
};

const LEGACY: Record<string, string> = {
  '🤖': 'bot:violet', '🦉': 'eye:amber', '🌙': 'moon:blue', '🦊': 'code:orange', '🐙': 'cpu:fuchsia', '⚡': 'zap:amber',
  '🧪': 'test:emerald', '🛠️': 'wrench:slate', '🎨': 'palette:rose', '🔍': 'search:sky', '🚀': 'rocket:violet', '🧠': 'brain:fuchsia'
};

export function parseAvatar(avatar?: string): { icon: string; color: string } {
  const v = (avatar && LEGACY[avatar]) || avatar || 'bot:violet';
  const [icon, color] = v.split(':');
  return { icon: AGENT_ICONS[icon] ? icon : 'bot', color: AGENT_COLORS[color] ? color : 'violet' };
}

export function AgentIcon({ avatar, size = 18, className }: { avatar?: string; size?: number; className?: string }) {
  const { icon, color } = parseAvatar(avatar);
  const Icon = AGENT_ICONS[icon];
  const [from, to] = AGENT_COLORS[color];
  return (
    <span
      className={clsx('inline-grid shrink-0 place-items-center text-white', className)}
      style={{
        width: size, height: size,
        borderRadius: Math.max(4, size * 0.3),
        background: `linear-gradient(145deg, ${from}, ${to})`,
        boxShadow: `inset 0 1px 0 0 rgb(255 255 255 / .25), 0 ${size > 28 ? 6 : 2}px ${size > 28 ? 16 : 6}px -${size > 28 ? 6 : 2}px ${to}`
      }}
    >
      <Icon style={{ width: size * 0.56, height: size * 0.56, strokeWidth: size > 28 ? 1.9 : 2.2 }} />
    </span>
  );
}
