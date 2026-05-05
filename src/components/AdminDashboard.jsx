import { useEffect, useState } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase/config';
import { useAuth } from '../contexts/AuthContext';
import VendedorDashboard from './VendedorDashboard';
import MetaCard from './MetaCard';
import GraficoVendasMensais from './GraficoVendasMensais';
import GestaoUsuarios from './GestaoUsuarios';

const MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

function moeda(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Remove o sufixo de estado do nome do vendedor (ex: "Diogo MG" → "Diogo")
function normalizarVendedor(nome) {
  return String(nome || '').replace(/\s+[A-Z]{2}$/, '').trim();
}

export default function AdminDashboard() {
  const { logout, usuario } = useAuth();
  const hoje = new Date();
  const [mes, setMes] = useState(hoje.getMonth() + 1);
  const [ano, setAno] = useState(hoje.getFullYear());
  const [resumo, setResumo] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [vendedorSelecionado, setVendedorSelecionado] = useState(null);
  const [abaMetas, setAbaMetas] = useState(false);
  const [abaUsuarios, setAbaUsuarios] = useState(false);

  const anos = [];
  for (let a = hoje.getFullYear(); a >= hoje.getFullYear() - 3; a--) anos.push(a);

  useEffect(() => {
    async function buscar() {
      setCarregando(true);
      try {
        const prefixo = `${ano}-${String(mes).padStart(2, '0')}`;
        const q = query(
          collection(db, 'pedidos'),
          where('dataVenda', '>=', `${prefixo}-01`),
          where('dataVenda', '<=', `${prefixo}-31`)
        );
        const snap = await getDocs(q);
        const pedidos = snap.docs.map((d) => d.data());

        // Agrupa por vendedor (sem estado), somando todas as UFs
        const mapa = {};
        for (const p of pedidos) {
          const v = normalizarVendedor(p.vendedor) || 'Sem vendedor';
          if (!mapa[v]) mapa[v] = { vendedor: v, faturamento: 0, comissao: 0, vendas: new Set(), produtos: 0 };
          mapa[v].faturamento += Number(p.faturamento || 0);
          mapa[v].comissao    += Number(p.comissao    || 0);
          mapa[v].produtos    += 1;
          // Extrai numeroVenda da chave para contar vendas únicas
          const chave = p.chave || '';
          const partes = chave.split('_');
          const vendaId = partes.length >= 2 ? `${p.contaAzul}_${partes[1]}` : chave;
          if (vendaId) mapa[v].vendas.add(vendaId);
        }

        // Converte Set em número
        for (const v in mapa) mapa[v].vendas = mapa[v].vendas.size;

        const lista = Object.values(mapa).sort((a, b) => b.comissao - a.comissao);
        setResumo(lista);
      } catch (err) {
        console.error(err);
      } finally {
        setCarregando(false);
      }
    }
    buscar();
  }, [mes, ano]);

  if (vendedorSelecionado) {
    return (
      <VendedorDashboard
        vendedorNome={vendedorSelecionado}
        mesInicial={mes}
        anoInicial={ano}
        onVoltar={() => setVendedorSelecionado(null)}
      />
    );
  }

  const totalGeral = resumo.reduce((s, r) => s + r.comissao, 0);
  const fatGeral = resumo.reduce((s, r) => s + r.faturamento, 0);

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div>
            <h1 style={styles.headerTitle}>👑 Painel Admin</h1>
            <p style={styles.headerSub}>Visão consolidada de todos os vendedores</p>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={() => { setAbaMetas(false); setAbaUsuarios(false); }} style={{ ...styles.btnSair, background: !abaMetas && !abaUsuarios ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)' }}>Comissões</button>
            <button onClick={() => { setAbaMetas(true);  setAbaUsuarios(false); }} style={{ ...styles.btnSair, background:  abaMetas && !abaUsuarios ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)' }}>🎯 Metas</button>
            <button onClick={() => { setAbaUsuarios(true); setAbaMetas(false); }} style={{ ...styles.btnSair, background: abaUsuarios ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)' }}>👥 Usuários</button>
            <button onClick={logout} style={styles.btnSair}>Sair</button>
          </div>
        </div>
      </header>

      <main style={styles.main}>
        {/* Aba Usuários */}
        {abaUsuarios && (
          <GestaoUsuarios usuarioLogadoUID={usuario?.uid} />
        )}

        {/* Filtros + conteúdo principal — ocultos na aba Usuários */}
        {!abaUsuarios && <>
        <div style={styles.filtros}>
          <select value={mes} onChange={(e) => setMes(Number(e.target.value))} style={styles.select}>
            {MESES.map((m, i) => (
              <option key={i + 1} value={i + 1}>{m}</option>
            ))}
          </select>
          <select value={ano} onChange={(e) => setAno(Number(e.target.value))} style={styles.select}>
            {anos.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>

        {/* Totais gerais */}
        <div style={styles.cards}>
          <div style={{ ...styles.card, borderLeft: '4px solid #0f3460' }}>
            <p style={styles.cardLabel}>Faturamento total</p>
            <p style={styles.cardValor}>{moeda(fatGeral)}</p>
          </div>
          <div style={{ ...styles.card, borderLeft: '4px solid #16a34a' }}>
            <p style={styles.cardLabel}>Comissões totais</p>
            <p style={{ ...styles.cardValor, color: '#16a34a' }}>{moeda(totalGeral)}</p>
          </div>
          <div style={{ ...styles.card, borderLeft: '4px solid #7c3aed' }}>
            <p style={styles.cardLabel}>Vendedores ativos</p>
            <p style={{ ...styles.cardValor, color: '#7c3aed' }}>{resumo.length}</p>
          </div>
        </div>

        {/* Gráfico de faturamento mensal — todos os vendedores */}
        {!abaMetas && (
          <GraficoVendasMensais
            vendedor={null}
            titulo="Faturamento total da equipe · últimos 12 meses"
          />
        )}

        {/* Aba Metas */}
        {abaMetas && (
          <div>
            {resumo.map((r) => (
              <MetaCard
                key={r.vendedor}
                vendedor={r.vendedor}
                mes={mes}
                ano={ano}
                fatAtual={r.faturamento}
              />
            ))}
            {resumo.length === 0 && !carregando && (
              <div style={styles.vazio}>Selecione um período com dados para ver as metas.</div>
            )}
          </div>
        )}

        {/* Tabela de vendedores */}
        {!abaMetas && (
          carregando ? (
            <div style={styles.centralizando}>
              <div style={styles.spinner} />
              <p style={{ color: '#6b7280' }}>Carregando dados...</p>
            </div>
          ) : resumo.length === 0 ? (
            <div style={styles.vazio}>
              <p>Nenhum dado encontrado para {MESES[mes - 1]} de {ano}.</p>
            </div>
          ) : (
            <div style={styles.tabela}>
              <div style={styles.tabelaHeader}>
                <span style={{ flex: 2 }}>Vendedor</span>
                <span style={{ flex: 1, textAlign: 'right' }}>Vendas</span>
                <span style={{ flex: 2, textAlign: 'right' }}>Faturamento</span>
                <span style={{ flex: 2, textAlign: 'right' }}>Comissão</span>
                <span style={{ flex: 1 }}></span>
              </div>
              {resumo.map((r, idx) => (
                <div key={r.vendedor} style={{ ...styles.tabelaRow, background: idx % 2 === 0 ? '#fff' : '#f9fafb' }}>
                  <div style={{ flex: 2 }}>
                    <span style={styles.nomeVendedor}>{r.vendedor}</span>
                    {r.estado && <span style={styles.estadoBadge}>{r.estado}</span>}
                  </div>
                  <span style={{ flex: 1, textAlign: 'right', color: '#6b7280', fontSize: '14px' }}>{r.vendas}</span>
                  <span style={{ flex: 2, textAlign: 'right', fontSize: '14px', fontWeight: '500' }}>{moeda(r.faturamento)}</span>
                  <span style={{ flex: 2, textAlign: 'right', fontSize: '15px', fontWeight: '700', color: '#16a34a' }}>{moeda(r.comissao)}</span>
                  <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
                    <button onClick={() => setVendedorSelecionado(r.vendedor)} style={styles.btnDetalhe}>
                      Ver extrato
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
        </>}
      </main>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#f3f4f6', fontFamily: 'Inter, sans-serif' },
  header: { background: '#0f3460', color: '#fff', padding: '0 20px' },
  headerInner: { maxWidth: '1000px', margin: '0 auto', padding: '16px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { margin: 0, fontSize: '20px', fontWeight: '700' },
  headerSub: { margin: 0, fontSize: '13px', opacity: 0.8, marginTop: '2px' },
  btnSair: { background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', color: '#fff', padding: '7px 16px', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontFamily: 'inherit' },
  main: { maxWidth: '1000px', margin: '0 auto', padding: '24px 16px' },
  filtros: { display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' },
  select: { padding: '9px 14px', border: '1.5px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', background: '#fff', cursor: 'pointer', fontFamily: 'inherit', outline: 'none' },
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '24px' },
  card: { background: '#fff', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' },
  cardLabel: { margin: '0 0 6px', fontSize: '12px', color: '#6b7280', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em' },
  cardValor: { margin: 0, fontSize: '26px', fontWeight: '700', color: '#111827' },
  tabela: { background: '#fff', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' },
  tabelaHeader: { display: 'flex', alignItems: 'center', padding: '12px 16px', background: '#f8fafc', borderBottom: '2px solid #e5e7eb', fontSize: '12px', fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' },
  tabelaRow: { display: 'flex', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid #f0f0f0', gap: '8px' },
  nomeVendedor: { fontWeight: '600', fontSize: '14px', color: '#111827', marginRight: '8px' },
  estadoBadge: { fontSize: '11px', padding: '2px 7px', borderRadius: '20px', background: '#ede9fe', color: '#7c3aed', fontWeight: '600' },
  btnDetalhe: { fontSize: '12px', padding: '5px 12px', background: '#0f3460', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: '500' },
  centralizando: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '60px 0', gap: '12px' },
  spinner: { width: '32px', height: '32px', border: '3px solid #e5e7eb', borderTop: '3px solid #0f3460', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
  vazio: { textAlign: 'center', padding: '60px 0', color: '#6b7280', background: '#fff', borderRadius: '12px' },
};
