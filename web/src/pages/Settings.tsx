import { useEffect, useRef } from 'react';
import { Navigate, NavLink, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { Bot, Server, Settings as SettingsIcon, ShieldCheck, UserRound, Users } from 'lucide-react';
import { useWs } from '../components/Layout';
import { can, canSee, useMe } from '../lib/queries';
import type { User } from '../lib/types';
import { AccountPage, ServerPage, UsersPage } from './Account';
import { RolesPage } from './Roles';
import { t } from '../lib/i18n';

// General settings: people, access, server and your account. What belongs to the
// workspace (workflow, repositories) and to the AI (agents, skills) is in the side menu.
export interface SettingsTab {
  id: string;
  label: string;
  group: string;
  icon: typeof Bot;
  allowed: (u?: User) => boolean;
  page: () => JSX.Element;
}

export const SETTINGS_TABS: SettingsTab[] = [
  { id: 'users', label: t('Users'), group: t('People & access'), icon: Users, allowed: (u) => canSee(u, 'users'), page: () => <UsersPage /> },
  { id: 'permissions', label: t('Permissions'), group: t('People & access'), icon: ShieldCheck, allowed: (u) => !!u?.isOwner, page: () => <RolesPage /> },
  { id: 'server', label: t('Server'), group: t('System'), icon: Server, allowed: (u) => can(u, 'settings.manage', 'repo.create'), page: () => <ServerPage /> },
  { id: 'account', label: t('My account'), group: t('You'), icon: UserRound, allowed: () => true, page: () => <AccountPage /> }
];

export function SettingsPage() {
  const { tab } = useParams();
  const { ws } = useWs();
  const { data: me } = useMe();
  const tabs = SETTINGS_TABS.filter((tt) => tt.allowed(me));
  const current = tabs.find((tt) => tt.id === tab);
  const groups = [...new Set(tabs.map((tt) => tt.group))];
  const bar = useRef<HTMLDivElement>(null);
  // No celular a barra rola na horizontal: mostra a aba atual.
  useEffect(() => {
    bar.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [tab]);

  if (!current) return <Navigate to={`/w/${ws.key}/config/${tabs[0].id}`} replace />;
  return (
    <div className="flex h-full flex-col md:flex-row">
      <nav className="shrink-0 border-b border-line/70 bg-panel/30 md:w-56 md:border-b-0 md:border-r">
        <div className="hidden items-center gap-2 px-4 pb-2 pt-5 text-[13px] font-semibold md:flex"><SettingsIcon className="size-4 text-accent" /> {t('General settings')}</div>
        {/* Phone: tabs scrolling horizontally; desktop: a grouped list. */}
        <div ref={bar} className="flex gap-1 overflow-x-auto px-2 py-2 md:block md:space-y-3 md:overflow-visible md:py-2">
          {groups.map((g) => (
            <div key={g} className="contents md:block">
              <div className="hidden px-2 pb-1 text-[11px] font-medium text-mute md:block">{g}</div>
              {tabs.filter((tt) => tt.group === g).map((tt) => (
                <NavLink key={tt.id} to={`/w/${ws.key}/config/${tt.id}`}
                  className={({ isActive }) => clsx('flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[13px] transition-colors md:w-full',
                    isActive ? 'bg-white/[0.07] text-fg' : 'text-dim hover:bg-white/[0.04] hover:text-fg')}>
                  <tt.icon className="size-4" /> {tt.label}
                </NavLink>
              ))}
            </div>
          ))}
        </div>
      </nav>
      <div className="min-h-0 min-w-0 flex-1">{current.page()}</div>
    </div>
  );
}
