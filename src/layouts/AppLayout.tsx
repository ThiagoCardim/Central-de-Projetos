import { useState, type ReactNode } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useAuth } from "@/services/auth";
import { can } from "@/permissions";
import { NAVIGATION, type NavItem } from "@/permissions/navigation";
import { Brand } from "@/components/domain/Brand";
import { Icon } from "@/components/ui/Icon";
import { Avatar, Button } from "@/components/ui/primitives";
import { Drawer } from "@/components/ui/overlays";
import { useTheme } from "@/hooks";
import { EMPLOYMENT_LABEL, ROLE_LABEL } from "@/utils/format";

function NavEntry({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  if (item.stage) {
    return (
      <span className="nav__item" aria-disabled="true" title={`${item.label} — disponível na ${item.stage}`}>
        <Icon name={item.icon} />
        <span className="nav__label">{item.label}</span>
        <span className="nav__stage">{item.stage}</span>
      </span>
    );
  }
  return (
    <NavLink to={item.to} end={item.to === "/"} className="nav__item" title={item.label} onClick={onNavigate}>
      <Icon name={item.icon} />
      <span className="nav__label">{item.label}</span>
    </NavLink>
  );
}

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const { permissions } = useAuth();
  return (
    <nav className="nav" aria-label="Navegação principal">
      {NAVIGATION.map((section, i) => {
        const items = section.items.filter((it) => can(permissions, it.requires));
        if (items.length === 0) return null;
        return (
          <div className="nav__section" key={section.title ?? i}>
            {section.title && <span className="label nav__title">{section.title}</span>}
            {items.map((it) => <NavEntry key={it.key} item={it} onNavigate={onNavigate} />)}
          </div>
        );
      })}
    </nav>
  );
}

function UserSummary() {
  const { profile } = useAuth();
  if (!profile) return null;
  const meta = [ROLE_LABEL[profile.role], profile.employment_type && EMPLOYMENT_LABEL[profile.employment_type]]
    .filter(Boolean).join(" · ");
  return (
    <div className="usercard" title={`${profile.name} — ${meta}`}>
      <Avatar name={profile.name} src={profile.avatar_url} />
      <span className="usercard__text">
        <span className="usercard__name">{profile.name}</span>
        <span className="usercard__meta">{meta}</span>
      </span>
    </div>
  );
}

function SessionActions() {
  const { signOut } = useAuth();
  const [theme, setTheme] = useTheme();
  return (
    <div className="sidebar__actions">
      <Button variant="ghost" size="sm" icon={theme === "dark" ? "sun" : "moon"}
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        title={theme === "dark" ? "Usar tema claro" : "Usar tema escuro"}>
        <span>{theme === "dark" ? "Tema claro" : "Tema escuro"}</span>
      </Button>
      <Button variant="ghost" size="sm" icon="logout" onClick={() => void signOut()} title="Sair">
        <span>Sair</span>
      </Button>
    </div>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { profile, permissions } = useAuth();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const mobileItems = NAVIGATION.flatMap((s) => s.items).filter((it) => it.mobile && !it.stage && can(permissions, it.requires));

  return (
    <div className="app">
      <a href="#conteudo" className="sr-only">Pular para o conteúdo</a>

      <aside className="sidebar">
        <Brand />
        <Navigation />
        <div className="sidebar__foot">
          <UserSummary />
          <SessionActions />
        </div>
      </aside>

      <header className="topbar">
        <Brand />
        {profile && (
          <button type="button" className="topbar__user" onClick={() => setMenuOpen(true)} aria-label="Abrir menu da conta">
            <Avatar name={profile.name} src={profile.avatar_url} />
          </button>
        )}
      </header>

      <main id="conteudo" className="main" tabIndex={-1}>{children}</main>

      <nav className="bottomnav" aria-label="Navegação rápida">
        {mobileItems.map((it) => (
          <NavLink key={it.key} to={it.to} end={it.to === "/"}>
            <Icon name={it.icon} />
            <span>{it.label === "Controle de Acessos" ? "Acessos" : it.label}</span>
          </NavLink>
        ))}
        <button type="button" onClick={() => setMenuOpen(true)} aria-expanded={menuOpen}
          className={mobileItems.some((it) => pathname === it.to) ? undefined : "is-active"}>
          <Icon name="menu" />
          <span>Menu</span>
        </button>
      </nav>

      <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} title="Menu">
        <div className="mobile-menu stack">
          <UserSummary />
          <Navigation onNavigate={() => setMenuOpen(false)} />
          <SessionActions />
        </div>
      </Drawer>
    </div>
  );
}

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-head__text">
        <h1>{title}</h1>
        {subtitle && <p className="page-head__sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-head__actions">{actions}</div>}
    </div>
  );
}
