import { useEffect, useState } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase/config';

function moeda(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function diasUteisNoMes(ano, mes) {
  let count = 0;
  const total = new Date(ano, mes, 0).getDate();
  for (let d = 1; d <= total; d++) {
    const dow = new Date(ano, mes - 1, d).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function diasUteisPassados(ano, mes) {
  const hoje = new Date();
  const ultimoDia = new Date(ano, mes, 0).getDate();
  const limite = (ano === hoje.getFullYear() && mes === hoje.getMonth() + 1)
    ? hoje.getDate() : ultimoDia;
  let count = 0;
  for (let d = 1; d <= limite; d++) {
    const dow = new Date(ano, mes - 1, d).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function mesAnterior(ano, mes, n) {
  let m = mes - n, a = ano;
  while (m <= 0) { m += 12; a -= 1; }
  return { ano: a, mes: m };
}

function prefixo(ano, mes) {
  return `${ano}-${String(mes).padStart(2, '0')}`;
}

async function buscarHistorico(ano, mes, vendedor) {
  const meses = [1, 2, 3].map((n) => mesAnterior(ano, mes, n));
  const byMonth = {};

  if (vendedor) {
    const q = query(collection(db, 'pedidos'), where('vendedor', '==', vendedor));
    const snap = await getDocs(q);
    snap.docs.forEach((d) => {
      const pref = (d.data().dataVenda || '').slice(0, 7);
      byMonth[pref] = (byMonth[pref] || 0) + Number(d.data().faturamento || 0);
    });
  } else {
    const oldest = meses[2];
    const newest = meses[0];
    const q = query(
      collection(db, 'pedidos'),
      where('dataVenda', '>=', `${prefixo(oldest.ano, oldest.mes)}-01`),
      where('dataVenda', '<=', `${prefixo(newest.ano, newest.mes)}-31`)
    );
    const snap = await getDocs(q);
    snap.docs.forEach((d) => {
      const pref = (d.data().dataVenda || '').slice(0, 7);
      byMonth[pref] = (byMonth[pref] || 0) + Number(d.data().faturamento || 0);
    });
  }

  return meses.map((m) => ({
    mes: m,
    fat: byMonth[prefixo(m.ano, m.mes)] || 0,
  }));
}

const NOMES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

export default function MetaCard({ vendedor, mes, ano, fatAtual }) {
  const [historico, setHistorico] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro]           = useState(null);

  useEffect(() => {
    setErro(null);
    setHistorico(null);
    setCarregando(true);
    buscarHistorico(ano, mes, vendedor)
      .then(setHistorico)
      .catch((e) => { console.error(e); setErro('Erro ao carregar histórico.'); })
      .finally(() => setCarregando(false));
  }, [vendedor, mes, ano]);

  if (carregando) return (
    <div style={s.card}>
      <p style={{ color: '#6b7280', fontSize: '13px' }}>Calculando{vendedor ? ` — ${vendedor}` : ''}...</p>
    </div>
  );
  if (erro) return <div style={s.card}><p style={{ color: '#dc2626', fontSize: '13px' }}>{erro}</p></div>;

  const fats    = historico.map((h) => h.fat);
  const media3m = fats.reduce((a, b) => a + b, 0) / 3;

  if (media3m === 0) return (
    <div style={s.card}>
      <div style={s.header}>
        <span style={s.nome}>{vendedor || 'Geral'}</span>
      </div>
      <p style={{ color: '#6b7280', fontSize: '13px' }}>Sem histórico dos últimos 3 meses.</p>
    </div>
  );

  const queda      = media3m * 0.90;
  const estab      = media3m;
  const crescMod   = media3m * 1.10;
  const crescAcent = media3m * 1.25;

  const duTotal  = diasUteisNoMes(ano, mes);
  const duPass   = diasUteisPassados(ano, mes);
  const projecao = duPass > 0 ? (fatAtual / duPass) * duTotal : 0;

  const hoje      = new Date();
  const eMesAtual = ano === hoje.getFullYear() && mes === hoje.getMonth() + 1;

  const barMax = Math.max(crescAcent * 1.2, projecao * 1.05, fatAtual * 1.05, 1);
  const pct    = (v) => Math.min((v / barMax) * 100, 100);

  // Tendência baseada na projeção (mês atual) ou no realizado (mês passado)
  const refVal = eMesAtual && projecao > 0 ? projecao : fatAtual;
  const mQE = (queda + estab) / 2;
  const mEM = (estab + crescMod) / 2;
  const mMA = (crescMod + crescAcent) / 2;
  let tendencia;
  if (refVal < mQE)      tendencia = { label: 'Tendência de Queda',                cor: '#dc2626', bg: '#fee2e2' };
  else if (refVal < mEM) tendencia = { label: 'Tendência de Estabilidade',          cor: '#d97706', bg: '#fef3c7' };
  else if (refVal < mMA) tendencia = { label: 'Tendência de Crescimento Moderado',  cor: '#16a34a', bg: '#dcfce7' };
  else                   tendencia = { label: 'Tendência de Crescimento Acentuado', cor: '#0f3460', bg: '#dbeafe' };

  // Cor do preenchimento sólido baseada na zona do realizado
  const solidColor = fatAtual >= crescAcent ? '#0f3460'
    : fatAtual >= crescMod ? '#16a34a'
    : fatAtual >= estab    ? '#d97706'
    : fatAtual >= queda    ? '#f59e0b'
    : '#dc2626';

  const progresso = Math.min((fatAtual / crescMod) * 100, 100);

  const markers = [
    { v: queda,      label: 'Queda',   cor: '#dc2626' },
    { v: estab,      label: 'Estab.',  cor: '#d97706' },
    { v: crescMod,   label: 'Meta ★',  cor: '#16a34a' },
    { v: crescAcent, label: 'Acent.',  cor: '#0f3460' },
  ];

  // Altura do espaço acima da régua (para os marcadores ficarem visíveis)
  const ABOVE = 36; // px acima da barra colorida (maior p/ caber valor da meta)
  const BAR_H = 18; // px altura da barra colorida

  return (
    <div style={s.card}>
      {/* Cabeçalho */}
      <div style={s.header}>
        <span style={s.nome}>{vendedor || 'Geral'}</span>
        <span style={{ ...s.badge, color: tendencia.cor, background: tendencia.bg }}>
          {tendencia.label}
        </span>
      </div>

      {/* Histórico compacto */}
      <div style={s.hist}>
        {[...historico].reverse().map((h, i) => (
          <span key={i} style={s.histItem}>
            <span style={s.histMes}>{NOMES[h.mes.mes - 1]}/{String(h.mes.ano).slice(2)}</span>
            <span style={s.histVal}>{moeda(h.fat)}</span>
          </span>
        ))}
      </div>

      {/*
        ── RÉGUA VERTICAL ──────────────────────────────────────────────
        Barra vertical com zonas coloridas. Labels à esquerda com linhas
        horizontais apontando para a posição correspondente.
      */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', minHeight: '190px' }}>

        {/* Labels à esquerda */}
        <div style={{ flex: 1, position: 'relative' }}>
          {markers.map((m) => {
            const isMeta = m.label === 'Meta ★';
            return (
              <div key={m.label} style={{
                position: 'absolute',
                bottom: `${pct(m.v)}%`,
                left: 0, right: 0,
                transform: 'translateY(50%)',
                display: 'flex', alignItems: 'center', gap: '5px',
                pointerEvents: 'none',
              }}>
                <div style={{ width: '10px', height: '2px', background: m.cor, flexShrink: 0 }} />
                <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                  <span style={{ fontSize: '11px', fontWeight: '700', color: m.cor, whiteSpace: 'nowrap' }}>{m.label}</span>
                  {isMeta && <span style={{ fontSize: '10px', fontWeight: '600', color: m.cor }}>{moeda(crescMod)}</span>}
                </div>
              </div>
            );
          })}

          {/* Marcador de Projeção */}
          {eMesAtual && projecao > 0 && (
            <div style={{
              position: 'absolute',
              bottom: `${Math.min(pct(projecao), 96)}%`,
              left: 0, right: 0,
              transform: 'translateY(50%)',
              display: 'flex', alignItems: 'center', gap: '5px',
              pointerEvents: 'none', zIndex: 4,
            }}>
              <div style={{ width: '10px', height: '0', borderTop: '2px dashed #1d4ed8', flexShrink: 0 }} />
              <span style={{ fontSize: '11px', fontWeight: '700', color: '#1d4ed8', whiteSpace: 'nowrap' }}>Proj.</span>
            </div>
          )}

          {/* Marcador do realizado */}
          {fatAtual > 0 && (
            <div style={{
              position: 'absolute',
              bottom: `${Math.min(pct(fatAtual), 96)}%`,
              left: 0, right: 0,
              transform: 'translateY(50%)',
              display: 'flex', alignItems: 'center', gap: '5px',
              pointerEvents: 'none', zIndex: 5,
            }}>
              <div style={{ width: '10px', height: '3px', background: solidColor, flexShrink: 0, borderRadius: '2px' }} />
              <span style={{ fontSize: '11px', fontWeight: '700', color: solidColor, whiteSpace: 'nowrap' }}>Atual</span>
            </div>
          )}
        </div>

        {/* Barra vertical */}
        <div style={{ width: '28px', position: 'relative', flexShrink: 0, borderRadius: '6px', overflow: 'hidden', background: '#f3f4f6' }}>
          {/* Zonas de cor — de baixo para cima */}
          <div style={{ position: 'absolute', bottom: 0,                     left: 0, right: 0, height: `${pct(queda)}%`,                          background: '#fecaca' }} />
          <div style={{ position: 'absolute', bottom: `${pct(queda)}%`,     left: 0, right: 0, height: `${pct(estab) - pct(queda)}%`,              background: '#fef08a' }} />
          <div style={{ position: 'absolute', bottom: `${pct(estab)}%`,     left: 0, right: 0, height: `${pct(crescMod) - pct(estab)}%`,           background: '#bbf7d0' }} />
          <div style={{ position: 'absolute', bottom: `${pct(crescMod)}%`,  left: 0, right: 0, height: `${pct(crescAcent) - pct(crescMod)}%`,      background: '#86efac' }} />
          <div style={{ position: 'absolute', bottom: `${pct(crescAcent)}%`, left: 0, right: 0, height: `${100 - pct(crescAcent)}%`,               background: '#bfdbfe' }} />

          {/* Preenchimento do realizado */}
          {fatAtual > 0 && (
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${pct(fatAtual)}%`, background: 'rgba(0,0,0,0.18)', zIndex: 1 }} />
          )}

          {/* Linhas dos marcadores */}
          {markers.map((m) => (
            <div key={m.label} style={{ position: 'absolute', bottom: `${pct(m.v)}%`, left: 0, right: 0, height: '2px', background: m.cor, zIndex: 2 }} />
          ))}

          {/* Linha da projeção */}
          {eMesAtual && projecao > 0 && (
            <div style={{ position: 'absolute', bottom: `${Math.min(pct(projecao), 97)}%`, left: 0, right: 0, height: '3px', background: '#1d4ed8', zIndex: 3, opacity: 0.8 }} />
          )}
        </div>
      </div>

      {/* Resumo numérico */}
      <div style={s.resumo}>
        <div style={s.resumoItem}>
          <span style={s.resumoLabel}>Realizado</span>
          <span style={s.resumoValor}>{moeda(fatAtual)}</span>
        </div>
        {eMesAtual && projecao > 0 && (
          <div style={s.resumoItem}>
            <span style={s.resumoLabel}>Projeção</span>
            <span style={{ ...s.resumoValor, color: tendencia.cor }}>{moeda(projecao)}</span>
          </div>
        )}
        <div style={s.resumoItem}>
          <span style={s.resumoLabel}>{fatAtual >= crescMod ? ' ' : 'Falta para a meta'}</span>
          {fatAtual >= crescMod
            ? <span style={{ ...s.resumoValor, color: '#16a34a' }}>✓ Meta atingida!</span>
            : <span style={{ ...s.resumoValor, color: '#dc2626' }}>{moeda(crescMod - fatAtual)}</span>
          }
        </div>
      </div>

      {/* Barra de progresso — cor conversa com a tendência da projeção */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#6b7280' }}>
          <span>Progresso para a meta</span>
          <span style={{ fontWeight: '700', color: progresso >= 100 ? '#16a34a' : '#374151' }}>
            {progresso.toFixed(0)}%
          </span>
        </div>
        <div style={{ height: '8px', background: '#f3f4f6', borderRadius: '4px', overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            borderRadius: '4px',
            width: `${progresso}%`,
            background: tendencia.cor,
            transition: 'width 0.5s',
          }} />
        </div>
      </div>
    </div>
  );
}

const s = {
  card:        { background: '#fff', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', marginBottom: '16px' },
  header:      { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' },
  nome:        { fontSize: '15px', fontWeight: '700', color: '#111827' },
  badge:       { fontSize: '12px', fontWeight: '700', padding: '4px 10px', borderRadius: '20px' },
  hist:        { display: 'flex', gap: '20px', marginBottom: '20px', flexWrap: 'wrap', alignItems: 'baseline' },
  histItem:    { display: 'flex', flexDirection: 'column', gap: '1px' },
  histMes:     { fontSize: '10px', color: '#9ca3af', fontWeight: '600', textTransform: 'uppercase' },
  histVal:     { fontSize: '13px', color: '#374151', fontWeight: '500' },
  resumo:      { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px', marginBottom: '16px' },
  resumoItem:  { display: 'flex', flexDirection: 'column', gap: '2px' },
  resumoLabel: { fontSize: '10px', color: '#9ca3af', fontWeight: '600', textTransform: 'uppercase' },
  resumoValor: { fontSize: '18px', fontWeight: '700', color: '#111827' },
};
