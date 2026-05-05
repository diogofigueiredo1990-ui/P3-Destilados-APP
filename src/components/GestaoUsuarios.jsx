import { useState, useEffect } from 'react';
import { collection, getDocs, setDoc, updateDoc, doc } from 'firebase/firestore';
import { sendPasswordResetEmail } from 'firebase/auth';
import { db, auth } from '../firebase/config';

// ── Labels e cores por perfil ─────────────────────────────────
const PERFIL_LABEL = { vendedor: 'Vendedor', admin: 'Admin', financeiro: 'Financeiro' };
const PERFIL_COR   = { vendedor: '#1d4ed8', admin: '#7c3aed', financeiro: '#0891b2' };
const PERFIL_BG    = { vendedor: '#eff6ff', admin: '#f5f3ff', financeiro: '#ecfeff' };

// ── Erros da API Firebase traduzidos ─────────────────────────
const ERROS_FIREBASE = {
  EMAIL_EXISTS:          'Este e-mail já está cadastrado.',
  INVALID_EMAIL:         'E-mail inválido.',
  WEAK_PASSWORD:         'Senha fraca — use ao menos 6 caracteres.',
  OPERATION_NOT_ALLOWED: 'Cadastro não habilitado no Firebase Console.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Muitas tentativas. Aguarde alguns minutos.',
};

// ── Cria usuário via REST API (sem derrubar sessão do admin) ──
async function criarUsuarioREST(email, senha) {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: senha, returnSecureToken: false }),
    }
  );
  const data = await resp.json();
  if (!resp.ok) {
    const raw = data?.error?.message || 'UNKNOWN';
    // Mensagem pode vir como "WEAK_PASSWORD : Password should be at least..."
    const code = raw.split(' :')[0].trim();
    throw new Error(ERROS_FIREBASE[code] || `Erro Firebase: ${raw}`);
  }
  return data.localId; // UID do novo usuário
}

// ── Componente ────────────────────────────────────────────────
export default function GestaoUsuarios({ usuarioLogadoUID }) {
  const [usuarios,   setUsuarios]   = useState([]);
  const [vendedores, setVendedores] = useState([]); // nomes disponíveis para vincular
  const [carregando, setCarregando] = useState(true);
  const [showForm,   setShowForm]   = useState(false);
  const [salvando,   setSalvando]   = useState(false);
  const [acaoUID,    setAcaoUID]    = useState(null);
  const [erro,       setErro]       = useState('');
  const [sucesso,    setSucesso]    = useState('');

  const [form, setForm] = useState({
    email:    '',
    senha:    '',
    perfil:   'vendedor',
    vendedor: '',
  });

  // ── Carrega usuários + lista de vendedores ────────────────
  useEffect(() => {
    async function carregar() {
      try {
        const [snapU, snapV] = await Promise.all([
          getDocs(collection(db, 'usuarios')),
          getDocs(collection(db, 'metricasVendedores')),
        ]);

        const lista = snapU.docs
          .map(d => ({ uid: d.id, ...d.data() }))
          .sort((a, b) => (a.email || '').localeCompare(b.email || ''));
        setUsuarios(lista);

        const nomes = snapV.docs
          .map(d => d.data().vendedor)
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b));
        setVendedores(nomes);
      } catch (err) {
        console.error('Erro ao carregar usuários:', err);
      } finally {
        setCarregando(false);
      }
    }
    carregar();
  }, []);

  function flash(msg, tipo = 'sucesso') {
    if (tipo === 'sucesso') { setSucesso(msg); setTimeout(() => setSucesso(''), 5000); }
    else                    { setErro(msg);    setTimeout(() => setErro(''),    6000); }
  }

  // ── Criar novo usuário ────────────────────────────────────
  async function handleCriar(e) {
    e.preventDefault();
    setErro(''); setSucesso('');

    if (form.perfil === 'vendedor' && !form.vendedor) {
      setErro('Selecione o vendedor vinculado a esta conta.');
      return;
    }

    setSalvando(true);
    try {
      // 1. Cria no Firebase Auth via REST (sem alterar sessão atual)
      const uid = await criarUsuarioREST(form.email, form.senha);

      // 2. Salva perfil no Firestore
      const perfil = {
        email:    form.email,
        perfil:   form.perfil,
        ativo:    true,
        criadoEm: new Date().toISOString().slice(0, 10),
        ...(form.perfil === 'vendedor' ? { vendedor: form.vendedor } : {}),
      };
      await setDoc(doc(db, 'usuarios', uid), perfil);

      // 3. Atualiza lista local
      setUsuarios(prev =>
        [...prev, { uid, ...perfil }]
          .sort((a, b) => (a.email || '').localeCompare(b.email || ''))
      );

      // 4. Limpa o formulário
      setForm({ email: '', senha: '', perfil: 'vendedor', vendedor: '' });
      setShowForm(false);
      flash(`✅ Usuário ${form.email} criado! Envie o link do app + e-mail + senha provisória para ele.`);
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  // ── Ativar / desativar acesso ─────────────────────────────
  async function toggleAtivo(uid, ativoAtual) {
    if (uid === usuarioLogadoUID) {
      flash('Você não pode desativar a sua própria conta.', 'erro');
      return;
    }
    setAcaoUID(uid);
    try {
      const novoAtivo = !ativoAtual;
      await updateDoc(doc(db, 'usuarios', uid), { ativo: novoAtivo });
      setUsuarios(prev => prev.map(u => u.uid === uid ? { ...u, ativo: novoAtivo } : u));
      flash(novoAtivo ? 'Acesso reativado.' : 'Acesso desativado. O usuário será desconectado no próximo login.');
    } catch (err) {
      flash('Erro ao atualizar: ' + err.message, 'erro');
    } finally {
      setAcaoUID(null);
    }
  }

  // ── Enviar link de redefinição de senha ───────────────────
  async function resetarSenha(email) {
    setAcaoUID(email);
    try {
      await sendPasswordResetEmail(auth, email);
      flash(`Link de redefinição enviado para ${email}`);
    } catch (err) {
      flash('Erro ao enviar e-mail: ' + err.message, 'erro');
    } finally {
      setAcaoUID(null);
    }
  }

  // ── Render ────────────────────────────────────────────────
  if (carregando) {
    return <div style={{ padding: '48px', textAlign: 'center', color: '#9ca3af' }}>⏳ Carregando...</div>;
  }

  const ativos   = usuarios.filter(u => u.ativo !== false).length;
  const inativos = usuarios.length - ativos;

  return (
    <div>
      {/* Cabeçalho */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: '700', color: '#111827' }}>
            👥 Gestão de Usuários
          </h2>
          <p style={{ margin: '3px 0 0', fontSize: '12px', color: '#6b7280' }}>
            {ativos} ativo{ativos !== 1 ? 's' : ''}
            {inativos > 0 && <span style={{ color: '#dc2626' }}> · {inativos} inativo{inativos !== 1 ? 's' : ''}</span>}
          </p>
        </div>
        <button
          onClick={() => { setShowForm(v => !v); setErro(''); }}
          style={{
            background: showForm ? '#f3f4f6' : '#0f3460',
            color: showForm ? '#374151' : '#fff',
            border: 'none', borderRadius: '8px', padding: '9px 18px',
            fontSize: '13px', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          {showForm ? '✕ Cancelar' : '+ Novo usuário'}
        </button>
      </div>

      {/* Feedback */}
      {sucesso && (
        <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', color: '#166534', fontSize: '13px' }}>
          {sucesso}
        </div>
      )}
      {erro && !showForm && (
        <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', color: '#dc2626', fontSize: '13px' }}>
          ⚠️ {erro}
        </div>
      )}

      {/* Formulário de criação */}
      {showForm && (
        <div style={{ background: '#f8fafc', border: '1.5px solid #e2e8f0', borderRadius: '12px', padding: '20px 24px', marginBottom: '20px' }}>
          <p style={{ margin: '0 0 16px', fontSize: '14px', fontWeight: '700', color: '#1e293b' }}>
            Novo usuário
          </p>
          <form onSubmit={handleCriar}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px' }}>

              <div style={st.campo}>
                <label style={st.label}>E-mail *</label>
                <input
                  type="email" required
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="vendedor@empresa.com"
                  style={st.input}
                />
              </div>

              <div style={st.campo}>
                <label style={st.label}>Senha provisória *</label>
                <input
                  type="text" required minLength={6}
                  value={form.senha}
                  onChange={e => setForm(f => ({ ...f, senha: e.target.value }))}
                  placeholder="mínimo 6 caracteres"
                  style={st.input}
                />
                <span style={{ fontSize: '10px', color: '#9ca3af' }}>
                  O vendedor pode trocar depois
                </span>
              </div>

              <div style={st.campo}>
                <label style={st.label}>Perfil *</label>
                <select
                  value={form.perfil}
                  onChange={e => setForm(f => ({ ...f, perfil: e.target.value, vendedor: '' }))}
                  style={st.input}
                >
                  <option value="vendedor">Vendedor</option>
                  <option value="admin">Admin</option>
                  <option value="financeiro">Financeiro</option>
                </select>
              </div>

              {form.perfil === 'vendedor' && (
                <div style={st.campo}>
                  <label style={st.label}>Vincular ao vendedor *</label>
                  {vendedores.length > 0 ? (
                    <select
                      value={form.vendedor}
                      onChange={e => setForm(f => ({ ...f, vendedor: e.target.value }))}
                      required
                      style={st.input}
                    >
                      <option value="">Selecione...</option>
                      {vendedores.map(v => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text" required
                      value={form.vendedor}
                      onChange={e => setForm(f => ({ ...f, vendedor: e.target.value }))}
                      placeholder="Nome exato (ex: Ana GO)"
                      style={st.input}
                    />
                  )}
                  <span style={{ fontSize: '10px', color: '#9ca3af' }}>
                    Deve ser o nome exato do vendedor no sistema
                  </span>
                </div>
              )}
            </div>

            {erro && (
              <p style={{ margin: '14px 0 0', color: '#dc2626', fontSize: '13px', background: '#fef2f2', padding: '8px 12px', borderRadius: '6px' }}>
                ⚠️ {erro}
              </p>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '18px' }}>
              <button type="button" onClick={() => setShowForm(false)} style={st.btnSec}>
                Cancelar
              </button>
              <button type="submit" disabled={salvando} style={st.btnPrim}>
                {salvando ? 'Criando...' : 'Criar usuário'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Tabela de usuários */}
      {usuarios.length === 0 ? (
        <div style={{ background: '#fff', borderRadius: '12px', padding: '48px', textAlign: 'center', color: '#9ca3af', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' }}>
          <p style={{ margin: 0, fontSize: '14px' }}>Nenhum usuário cadastrado.</p>
          <p style={{ margin: '6px 0 0', fontSize: '12px' }}>Clique em "+ Novo usuário" para começar.</p>
        </div>
      ) : (
        <div style={{ background: '#fff', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' }}>
          {/* Header da tabela */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 100px 1fr 80px 110px', padding: '10px 16px', background: '#f8fafc', borderBottom: '2px solid #e5e7eb', fontSize: '11px', fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', gap: '8px' }}>
            <span>E-mail</span>
            <span>Perfil</span>
            <span>Vendedor</span>
            <span>Status</span>
            <span style={{ textAlign: 'right' }}>Ações</span>
          </div>

          {usuarios.map((u, idx) => {
            const isInativo  = u.ativo === false;
            const isSelf     = u.uid === usuarioLogadoUID;
            const processando = acaoUID === u.uid || acaoUID === u.email;

            return (
              <div
                key={u.uid}
                style={{
                  display: 'grid', gridTemplateColumns: '1.5fr 100px 1fr 80px 110px',
                  padding: '12px 16px', alignItems: 'center', gap: '8px',
                  borderBottom: idx < usuarios.length - 1 ? '1px solid #f3f4f6' : 'none',
                  background: isInativo ? '#fafafa' : '#fff',
                  opacity: isInativo ? 0.65 : 1,
                  transition: 'opacity 0.2s',
                }}
              >
                {/* E-mail */}
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontSize: '13px', color: '#111827', fontWeight: '500', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {u.email || '—'}
                  </span>
                  {u.criadoEm && (
                    <span style={{ fontSize: '10px', color: '#d1d5db' }}>
                      desde {u.criadoEm}
                    </span>
                  )}
                  {isSelf && (
                    <span style={{ fontSize: '10px', color: '#6366f1', fontWeight: '600' }}> · você</span>
                  )}
                </div>

                {/* Perfil */}
                <span style={{
                  display: 'inline-block',
                  fontSize: '11px', fontWeight: '600', padding: '3px 9px', borderRadius: '20px',
                  background: PERFIL_BG[u.perfil] || '#f3f4f6',
                  color: PERFIL_COR[u.perfil] || '#6b7280',
                }}>
                  {PERFIL_LABEL[u.perfil] || u.perfil}
                </span>

                {/* Vendedor vinculado */}
                <span style={{ fontSize: '12px', color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {u.vendedor || <span style={{ color: '#d1d5db' }}>—</span>}
                </span>

                {/* Status */}
                <span style={{
                  display: 'inline-block',
                  fontSize: '11px', fontWeight: '600', padding: '3px 9px', borderRadius: '20px',
                  background: isInativo ? '#fef2f2' : '#f0fdf4',
                  color:      isInativo ? '#dc2626'  : '#16a34a',
                }}>
                  {isInativo ? 'Inativo' : 'Ativo'}
                </span>

                {/* Ações */}
                <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                  {/* Redefinir senha por e-mail */}
                  <button
                    title="Enviar link de redefinição de senha"
                    onClick={() => resetarSenha(u.email)}
                    disabled={processando || !u.email}
                    style={st.btnIcone}
                  >
                    📧
                  </button>

                  {/* Ativar / desativar */}
                  <button
                    title={isInativo ? 'Reativar acesso' : 'Desativar acesso'}
                    onClick={() => toggleAtivo(u.uid, !isInativo)}
                    disabled={processando || isSelf}
                    style={{
                      ...st.btnIcone,
                      background: isInativo ? '#f0fdf4' : '#fff5f5',
                      color:      isInativo ? '#16a34a' : '#ef4444',
                      fontWeight: '700', fontSize: '12px',
                      opacity: isSelf ? 0.4 : 1,
                      cursor: isSelf ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {processando && acaoUID === u.uid ? '...' : isInativo ? '▶ On' : '■ Off'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Instrução de envio */}
      <div style={{ marginTop: '16px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '10px', padding: '12px 16px' }}>
        <p style={{ margin: 0, fontSize: '12px', color: '#92400e', fontWeight: '600' }}>
          💡 Como enviar o acesso para um vendedor
        </p>
        <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#78350f', lineHeight: '1.5' }}>
          Após criar a conta, envie por WhatsApp ou e-mail:<br />
          <strong>Link:</strong> {window.location.origin} &nbsp;|&nbsp;
          <strong>E-mail:</strong> o que você cadastrou &nbsp;|&nbsp;
          <strong>Senha:</strong> a senha provisória
        </p>
      </div>
    </div>
  );
}

// ── Estilos ───────────────────────────────────────────────────
const st = {
  campo:   { display: 'flex', flexDirection: 'column', gap: '4px' },
  label:   { fontSize: '12px', fontWeight: '600', color: '#374151' },
  input:   { padding: '9px 12px', border: '1.5px solid #e5e7eb', borderRadius: '8px', fontSize: '13px', outline: 'none', fontFamily: 'inherit', background: '#fff', color: '#111827' },
  btnPrim: { background: '#0f3460', color: '#fff', border: 'none', borderRadius: '8px', padding: '9px 20px', fontSize: '13px', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit' },
  btnSec:  { background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '8px', padding: '9px 16px', fontSize: '13px', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit' },
  btnIcone:{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: '6px', padding: '5px 10px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '14px', color: '#374151' },
};
