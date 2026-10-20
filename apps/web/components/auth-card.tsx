import { Brand } from './brand';
import { LanguageSwitcher } from './language-switcher';

/** Centered card used by sign-in, recovery and password pages. */
export function AuthCard({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="auth-page">
      <header className="auth-header">
        <Brand />
        <LanguageSwitcher />
      </header>
      <main id="main" className="auth-main">
        <section className="card auth-card" aria-labelledby="auth-title">
          <h1 id="auth-title">{title}</h1>
          {intro && <p className="muted">{intro}</p>}
          {children}
        </section>
      </main>
    </div>
  );
}
