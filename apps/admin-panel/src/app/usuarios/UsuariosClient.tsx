"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { criarUsuarioAction, atualizarUsuarioAction, gerarSenhaAction, type UsuarioPainel } from "./actions";
import { formatarDataHora } from "@/lib/data-hora";

const ROLE_LABEL: Record<UsuarioPainel["role"], string> = {
  ADMINISTRADOR: "Administrador",
  OPERADOR: "Operador",
  VISUALIZADOR: "Visualizador",
};

function fmtData(iso: string | null): string {
  if (!iso) return "Nunca";
  return formatarDataHora(iso);
}

function NovoUsuarioModal({ onFechar, onCriado }: { onFechar: () => void; onCriado: () => void }) {
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    const formData = new FormData(e.currentTarget);
    const resultado = await criarUsuarioAction(formData);
    setEnviando(false);
    if (resultado.ok) {
      onCriado();
      onFechar();
    } else {
      setErro(resultado.mensagem ?? "Não foi possível criar o usuário.");
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onFechar}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}
    >
      <form
        onSubmit={onSubmit}
        onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--surface-1)", borderRadius: 10, padding: 24, width: "min(420px, 92vw)", border: "1px solid var(--border)" }}
      >
        <h2 style={{ marginTop: 0 }}>Novo usuário</h2>

        {erro && (
          <p className="empty-state" style={{ borderColor: "var(--status-critical)", color: "var(--status-critical)" }}>
            {erro}
          </p>
        )}

        <label className="field-label" htmlFor="nome">Nome completo</label>
        <input id="nome" name="nome" type="text" required style={{ marginBottom: 12 }} />

        <label className="field-label" htmlFor="email">E-mail corporativo</label>
        <input id="email" name="email" type="email" required style={{ marginBottom: 12 }} />

        <label className="field-label" htmlFor="senha">Senha inicial</label>
        <input id="senha" name="senha" type="password" required minLength={6} style={{ marginBottom: 12 }} />

        <label className="field-label" htmlFor="role">Nível de acesso</label>
        <select id="role" name="role" defaultValue="OPERADOR" style={{ marginBottom: 20 }}>
          <option value="ADMINISTRADOR">Administrador — acesso total</option>
          <option value="OPERADOR">Operador — Dashboard e Ofertas</option>
          <option value="VISUALIZADOR">Visualizador — somente leitura</option>
        </select>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" className="secondary" onClick={onFechar}>
            Cancelar
          </button>
          <button type="submit" disabled={enviando}>
            {enviando ? "Criando…" : "Criar usuário"}
          </button>
        </div>
      </form>
    </div>
  );
}

function EditarUsuarioModal({
  usuario,
  onFechar,
  onSalvo,
}: {
  usuario: UsuarioPainel;
  onFechar: () => void;
  onSalvo: () => void;
}) {
  const [nome, setNome] = useState(usuario.nome);
  const [email, setEmail] = useState(usuario.email);
  const [role, setRole] = useState(usuario.role);
  const [ativo, setAtivo] = useState(usuario.ativo);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function salvar() {
    setEnviando(true);
    setErro(null);
    const resultado = await atualizarUsuarioAction(usuario.id, { nome, email, role, ativo });
    setEnviando(false);
    if (resultado.ok) {
      onSalvo();
      onFechar();
    } else {
      setErro(resultado.mensagem ?? "Não foi possível salvar.");
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onFechar}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--surface-1)", borderRadius: 10, padding: 24, width: "min(420px, 92vw)", border: "1px solid var(--border)" }}
      >
        <h2 style={{ marginTop: 0 }}>Editar usuário</h2>

        {erro && (
          <p className="empty-state" style={{ borderColor: "var(--status-critical)", color: "var(--status-critical)" }}>
            {erro}
          </p>
        )}

        <label className="field-label">Nome completo</label>
        <input type="text" value={nome} onChange={(e) => setNome(e.target.value)} style={{ marginBottom: 12 }} />

        <label className="field-label">E-mail corporativo</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ marginBottom: 12 }} />

        <label className="field-label">Nível de acesso</label>
        <select value={role} onChange={(e) => setRole(e.target.value as UsuarioPainel["role"])} style={{ marginBottom: 12 }}>
          <option value="ADMINISTRADOR">Administrador — acesso total</option>
          <option value="OPERADOR">Operador — Dashboard e Ofertas</option>
          <option value="VISUALIZADOR">Visualizador — somente leitura</option>
        </select>

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20, fontSize: 13 }}>
          <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} style={{ width: "auto" }} />
          Usuário ativo (desmarcar desativa o acesso imediatamente)
        </label>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" className="secondary" onClick={onFechar}>
            Cancelar
          </button>
          <button type="button" onClick={salvar} disabled={enviando}>
            {enviando ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function UsuariosClient() {
  const [usuarios, setUsuarios] = useState<UsuarioPainel[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [roleFiltro, setRoleFiltro] = useState("");
  const [modalNovo, setModalNovo] = useState(false);
  const [usuarioEditando, setUsuarioEditando] = useState<UsuarioPainel | null>(null);

  async function carregar() {
    setCarregando(true);
    setErro(null);
    try {
      const resp = await fetch("/api/users", { cache: "no-store" });
      const json = await resp.json();
      setUsuarios(Array.isArray(json) ? json : []);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    carregar();
  }, []);

  const filtrados = useMemo(() => {
    const buscaLower = busca.toLowerCase().trim();
    return usuarios.filter((u) => {
      const bateBusca = !buscaLower || u.nome.toLowerCase().includes(buscaLower) || u.email.toLowerCase().includes(buscaLower);
      const bateRole = !roleFiltro || u.role === roleFiltro;
      return bateBusca && bateRole;
    });
  }, [usuarios, busca, roleFiltro]);

  async function onGerarSenha(usuario: UsuarioPainel) {
    if (!confirm(`Gerar uma senha nova pra ${usuario.nome}? A senha atual dela deixa de funcionar.`)) return;
    const resultado = await gerarSenhaAction(usuario.id);
    if (resultado.ok && resultado.senhaTemporaria) {
      // Mostrado só nesse momento — depois disso não tem como recuperar de novo
      // (só o hash fica salvo). É por isso que aparece num alert em vez de só
      // um "sucesso" genérico.
      alert(`Senha temporária gerada para ${usuario.nome}:\n\n${resultado.senhaTemporaria}\n\nCopie agora — ela não aparece de novo.`);
    } else {
      alert(resultado.mensagem ?? "Não foi possível gerar a senha.");
    }
  }

  async function onAlternarAtivo(usuario: UsuarioPainel) {
    const acao = usuario.ativo ? "desativar" : "reativar";
    if (!confirm(`Quer mesmo ${acao} o acesso de ${usuario.nome}?`)) return;
    const resultado = await atualizarUsuarioAction(usuario.id, { ativo: !usuario.ativo });
    if (resultado.ok) carregar();
    else alert(resultado.mensagem ?? "Não foi possível atualizar.");
  }

  return (
    <div>
      <h1>Usuários</h1>
      <p className="subtitle">Gestão de acesso ao painel administrativo.</p>

      <div className="action-bar">
        <input type="text" placeholder="Buscar por nome ou e-mail" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <select value={roleFiltro} onChange={(e) => setRoleFiltro(e.target.value)}>
          <option value="">Todos os níveis</option>
          <option value="ADMINISTRADOR">Administrador</option>
          <option value="OPERADOR">Operador</option>
          <option value="VISUALIZADOR">Visualizador</option>
        </select>
        <button type="button" onClick={() => setModalNovo(true)}>
          + Novo usuário
        </button>
      </div>

      {erro && <p className="empty-state">Não foi possível carregar: {erro}</p>}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>E-mail</th>
              <th>Nível de acesso</th>
              <th>Status</th>
              <th>Último acesso</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {carregando && (
              <tr>
                <td colSpan={6} className="empty-state">Carregando…</td>
              </tr>
            )}
            {!carregando && filtrados.map((u) => (
              <tr key={u.id}>
                <td>{u.nome}</td>
                <td>{u.email}</td>
                <td>
                  <span className={`badge ${u.role === "ADMINISTRADOR" ? "good" : "neutral"}`}>{ROLE_LABEL[u.role]}</span>
                </td>
                <td>
                  <span className={`badge ${u.ativo ? "good" : ""}`}>{u.ativo ? "● Ativo" : "○ Inativo"}</span>
                </td>
                <td>{fmtData(u.ultimoAcesso)}</td>
                <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button type="button" className="secondary" onClick={() => setUsuarioEditando(u)}>
                    Editar
                  </button>
                  <button type="button" className="secondary" onClick={() => onGerarSenha(u)}>
                    Gerar senha
                  </button>
                  <button type="button" className="secondary" onClick={() => onAlternarAtivo(u)}>
                    {u.ativo ? "Desativar" : "Reativar"}
                  </button>
                </td>
              </tr>
            ))}
            {!carregando && filtrados.length === 0 && (
              <tr>
                <td colSpan={6} className="empty-state">Nenhum usuário encontrado.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modalNovo && <NovoUsuarioModal onFechar={() => setModalNovo(false)} onCriado={carregar} />}
      {usuarioEditando && (
        <EditarUsuarioModal usuario={usuarioEditando} onFechar={() => setUsuarioEditando(null)} onSalvo={carregar} />
      )}
    </div>
  );
}
