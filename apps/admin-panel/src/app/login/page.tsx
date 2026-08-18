import { login } from "./actions";

export default function LoginPage({ searchParams }: { searchParams: { erro?: string; proximaPagina?: string } }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--page-plane)",
      }}
    >
      <form
        action={login}
        style={{
          background: "var(--surface-1)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: 32,
          width: "min(360px, 92vw)",
          boxShadow: "0 12px 40px -16px rgba(11,11,11,0.2)",
        }}
      >
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Entrar</h1>
        <p className="subtitle" style={{ marginBottom: 20 }}>
          Plataforma de Ofertas — painel administrativo.
        </p>

        {searchParams.erro && (
          <p className="empty-state" style={{ borderColor: "#c0392b", color: "#c0392b", marginBottom: 16 }}>
            {searchParams.erro}
          </p>
        )}

        <input type="hidden" name="proximaPagina" value={searchParams.proximaPagina || "/"} />

        <label className="field-label" htmlFor="email">
          E-mail
        </label>
        <input id="email" name="email" type="email" required autoFocus style={{ marginBottom: 14 }} />

        <label className="field-label" htmlFor="senha">
          Senha
        </label>
        <input id="senha" name="senha" type="password" required style={{ marginBottom: 20 }} />

        <button type="submit" style={{ width: "100%" }}>
          Entrar
        </button>
      </form>
    </div>
  );
}
