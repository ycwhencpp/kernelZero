import type { ReactNode } from "react";

export function AuthShell({
  eyebrow = "PRIVATE WORKSPACE",
  title,
  intro,
  children,
  footer,
}: {
  eyebrow?: string;
  title: string;
  intro: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="auth-shell">
      <section className="auth-brand" aria-labelledby="auth-brand-title">
        <div className="auth-brand-accessible">
          <p className="auth-brand-mark" id="auth-brand-title">
            KernelZero
          </p>
          <h1>Research, distilled daily.</h1>
          <p>
            A private production workspace for evidence-grounded research and
            audio briefings.
          </p>
        </div>
      </section>

      <section className="auth-entry">
        <div className="auth-form-wrap">
          <div className="auth-user-placeholder" aria-hidden="true">
            <span />
          </div>
          <p className="organic-eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
          <p className="auth-intro">{intro}</p>
          {children}
          {footer}
        </div>
      </section>
    </main>
  );
}
