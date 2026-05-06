import { useState, useEffect, useMemo } from 'react';
import { hojeISO, dataParaISO } from '../utils/data';
import {
  ComposedChart, Bar, Line,
  XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase/config';

// ── Cache diário ──────────────────────────────────────────────
function lerCacheGrafico(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj.dia === hojeISO() ? obj.data : null;
  } catch { return null; }
}
function salvarCacheGrafico(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ dia: hojeISO(), data }));
  } catch {}
}

// ── Utilitários ───────────────────────────────────────────────
const MESES_CURTOS = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

function moedaCompacta(valor) {
  if (valor >= 1_000_000) return `R$${(valor / 1_000_000).toFixed(1)}M`;
  if (valor >= 1_000)     return `R$${(valor / 1_000).toFixed(0)}k`;
  return `R$${Math.round(valor)}`;
}

function moedaFull(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// ── Regressão linear: y = a + b*x ────────────────────────────
//
// Usa os 11 meses COMPLETOS (exclui o mês atual, que está em andamento).
// A linha é calculada para todos os meses históricos + 2 meses de projeção.
//
// Retorna: { dados, crescendo, inclinacaoMensal, r2 }
function calcularTendenciaLinear(meses) {
  // Os 11 meses anteriores ao atual (completos)
  const completos = meses.filter(m => !m.futuro && !m.parcial);

  const pontos = completos
    .map((d, i) => ({ x: i, y: d.faturamento }))
    .filter(p => p.y > 0); // exclui meses sem faturamento

  if (pontos.length < 3) {
    return { dados: meses.map(d => ({ ...d, tendencia: null })), crescendo: null, inclinacaoMensal: 0, r2: 0 };
  }

  const n    = pontos.length;
  const sumX = pontos.reduce((s, p) => s + p.x,       0);
  const sumY = pontos.reduce((s, p) => s + p.y,       0);
  const sumXY= pontos.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2= pontos.reduce((s, p) => s + p.x * p.x, 0);

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) {
    return { dados: meses.map(d => ({ ...d, tendencia: null })), crescendo: null, inclinacaoMensal: 0, r2: 0 };
  }

  const b = (n * sumXY - sumX * sumY) / denom;   // inclinação (R$/mês)
  const a = (sumY - b * sumX) / n;               // intercepto

  // R² — proporção da variância explicada pela tendência linear
  const yMean = sumY / n;
  const ssTot = pontos.reduce((s, p) => s + (p.y - yMean) ** 2,          0);
  const ssRes = pontos.reduce((s, p) => s + (p.y - (a + b * p.x)) ** 2,  0);
  const r2    = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  // Projeta a tendência para TODOS os itens do array (histórico + mês parcial + futuros)
  // O índice x de cada item segue a posição relativa em `meses`
  const dados = meses.map((d, i) => ({
    ...d,
    tendencia: Math.max(0, Math.round(a + b * i)),
  }));

  return { dados, crescendo: b > 0, inclinacaoMensal: Math.round(b), r2 };
}

// ── Monta array de meses (12 históricos + 2 projeções) ───────
function montarMeses() {
  const hoje  = new Date();
  const meses = [];

  // 12 meses históricos (0 = 11 meses atrás, 11 = mês atual)
  for (let i = 11; i >= 0; i--) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    meses.push({
      label:       `${MESES_CURTOS[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`,
      mes:         d.getMonth() + 1,
      ano:         d.getFullYear(),
      faturamento: 0,
      tendencia:   null,
      parcial:     i === 0,  // mês atual = em andamento
      futuro:      false,
    });
  }

  // 2 meses futuros (apenas tendência, sem barra)
  for (let i = 1; i <= 2; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() + i, 1);
    meses.push({
      label:       `${MESES_CURTOS[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`,
      mes:         d.getMonth() + 1,
      ano:         d.getFullYear(),
      faturamento: null,   // sem barra
      tendencia:   null,
      parcial:     false,
      futuro:      true,
    });
  }

  return meses;
}

// ── Tooltip customizado ───────────────────────────────────────
function TooltipCustom({ active, payload }) {
  if (!active || !payload?.length) return null;
  const entry    = payload[0]?.payload;
  const fat      = entry?.faturamento ?? null;
  const fatReal  = entry?.fatReal     ?? null; // faturamento real (quando projetado=true)
  const tend     = entry?.tendencia   ?? null;
  const parcial  = entry?.parcial;
  const projetado= entry?.projetado;
  const futuro   = entry?.futuro;
  const label    = entry?.label;

  const diff = (!parcial && !projetado && !futuro && fat !== null && tend !== null && tend > 0)
    ? ((fat - tend) / tend) * 100
    : null;

  return (
    <div style={{
      background: '#fff', border: '1px solid #e5e7eb',
      borderRadius: '10px', padding: '10px 14px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
      minWidth: '168px',
    }}>
      <p style={{ margin: '0 0 6px', fontWeight: '700', fontSize: '12px', color: futuro ? '#9ca3af' : '#374151' }}>
        {label}
        {projetado && <span style={{ fontWeight: '400', color: '#6366f1' }}> · projeção</span>}
        {parcial && !projetado && <span style={{ fontWeight: '400', color: '#9ca3af' }}> · mês parcial</span>}
        {futuro  && <span style={{ fontWeight: '400', color: '#9ca3af' }}> · futuro</span>}
      </p>

      {fat !== null && (
        <p style={{ margin: 0, fontSize: '13px', color: projetado ? '#6366f1' : '#0f3460', fontWeight: '600' }}>
          {projetado ? '🔮' : '📦'} {moedaFull(fat)}
          {projetado && fatReal !== null && (
            <span style={{ fontWeight: '400', color: '#9ca3af', fontSize: '11px', display: 'block', marginTop: '2px' }}>
              Atual: {moedaFull(fatReal)}
            </span>
          )}
          {parcial && !projetado && <span style={{ fontWeight: '400', color: '#9ca3af', fontSize: '11px' }}> (até hoje)</span>}
        </p>
      )}

      {tend !== null && (
        <p style={{ margin: '3px 0 0', fontSize: '11px', color: futuro ? '#6366f1' : '#f59e0b', fontWeight: futuro ? '600' : '400' }}>
          {futuro ? '🔮 Projeção:' : parcial ? '🎯 Meta mensal:' : '📈 Tendência:'} {moedaFull(tend)}
        </p>
      )}

      {diff !== null && (
        <p style={{
          margin: '3px 0 0', fontSize: '11px', fontWeight: '600',
          color: diff >= 0 ? '#16a34a' : '#dc2626',
        }}>
          {diff >= 0 ? `▲ +${diff.toFixed(1)}%` : `▼ ${diff.toFixed(1)}%`} vs tendência
        </p>
      )}
    </div>
  );
}

// ── Barra com cor condicional ─────────────────────────────────
// projetado = roxo (projeção de fechamento do mês)
// parcial   = azul claro (mês atual sem projeção)
// normal    = azul escuro
function BarCustomizada(props) {
  const { x, y, width, height, parcial, projetado } = props;
  if (!height || height <= 0) return null;
  const fill = projetado ? '#6366f1' : parcial ? '#93c5fd' : '#0f3460';
  return <rect x={x} y={y} width={width} height={height} fill={fill} rx={3} ry={3} />;
}

// ── Componente principal ──────────────────────────────────────
export default function GraficoVendasMensais({
  vendedor = null,
  titulo = 'Faturamento Mensal',
  showTendencia = false,
  projecaoMesAtual = null,  // se informado, substitui a barra do mês parcial pela projeção
}) {
  const [dados,             setDados]             = useState(null);
  const [carregando,        setCarregando]        = useState(true);
  const [crescendo,         setCrescendo]         = useState(null);
  const [inclinacaoMensal,  setInclinacaoMensal]  = useState(0);
  const [r2,                setR2]                = useState(0);

  useEffect(() => {
    const slug     = vendedor ? vendedor.toLowerCase().replace(/\s+/g, '_') : '_todos';
    const cacheKey = `grafico_fat_v3_${slug}`;

    async function buscar() {
      setCarregando(true);
      try {
        const cached = lerCacheGrafico(cacheKey);
        if (cached) {
          setDados(cached.dados);
          setCrescendo(cached.crescendo);
          setInclinacaoMensal(cached.inclinacaoMensal ?? 0);
          setR2(cached.r2 ?? 0);
          setCarregando(false);
          return;
        }

        const hoje      = new Date();
        const inicio    = new Date(hoje.getFullYear(), hoje.getMonth() - 11, 1);
        const inicioStr = dataParaISO(inicio);
        const fimStr    = dataParaISO(hoje);

        let snap;
        if (vendedor) {
          // Busca todos do vendedor e filtra data no JS (evita composite index)
          snap = await getDocs(
            query(collection(db, 'pedidos'), where('vendedor', '==', vendedor))
          );
        } else {
          snap = await getDocs(
            query(
              collection(db, 'pedidos'),
              where('dataVenda', '>=', inicioStr),
              where('dataVenda', '<=', fimStr),
            )
          );
        }

        const pedidos = snap.docs.map(d => d.data());

        // Monta estrutura dos meses (12 históricos + 2 projeções)
        const meses = montarMeses();

        pedidos.forEach(p => {
          const dv = String(p.dataVenda || '');
          if (dv.length < 7)                  return;
          if (dv < inicioStr || dv > fimStr)  return;
          const pAno = Number(dv.slice(0, 4));
          const pMes = Number(dv.slice(5, 7));
          const idx  = meses.findIndex(m => m.ano === pAno && m.mes === pMes);
          if (idx >= 0 && meses[idx].faturamento !== null) {
            meses[idx].faturamento += Number(p.faturamento || 0);
          }
        });

        meses.forEach(m => {
          if (m.faturamento !== null) m.faturamento = Math.round(m.faturamento);
        });

        // Regressão linear nos 11 meses completos, projeta para todos
        const resultado = calcularTendenciaLinear(meses);

        salvarCacheGrafico(cacheKey, resultado);
        setDados(resultado.dados);
        setCrescendo(resultado.crescendo);
        setInclinacaoMensal(resultado.inclinacaoMensal);
        setR2(resultado.r2);
      } catch (err) {
        console.error('GraficoVendasMensais erro:', err);
        setDados([]);
      } finally {
        setCarregando(false);
      }
    }

    buscar();
  }, [vendedor]);

  // ── Render ────────────────────────────────────────────────
  if (carregando) {
    return (
      <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', marginTop: '16px', textAlign: 'center' }}>
        <p style={{ margin: 0, color: '#9ca3af', fontSize: '13px' }}>⏳ Carregando gráfico...</p>
      </div>
    );
  }

  if (!dados || dados.length === 0) return null;

  // Se projecaoMesAtual informado, sobrepõe a barra do mês parcial com a projeção de fechamento
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const dadosExibidos = useMemo(() => {
    if (!dados || projecaoMesAtual === null) return dados;
    return dados.map(d =>
      d.parcial
        ? { ...d, faturamento: Math.round(projecaoMesAtual), projetado: true, fatReal: d.faturamento }
        : d
    );
  }, [dados, projecaoMesAtual]);

  const temTendencia = dadosExibidos.some(d => d.tendencia !== null);

  // Escala do eixo Y: usa apenas os meses históricos (não projeções futuras)
  const historico    = dadosExibidos.filter(d => !d.futuro);
  const maxFat       = Math.max(...historico.map(d => d.faturamento ?? 0), 1);
  const maxTend      = temTendencia ? Math.max(...historico.map(d => d.tendencia ?? 0), 0) : 0;
  const yMax         = Math.max(maxFat, maxTend) * 1.25;

  const mesAtualLabel = `${MESES_CURTOS[new Date().getMonth()]}/${String(new Date().getFullYear()).slice(2)}`;

  return (
    <div style={{
      background: '#fff', borderRadius: '12px',
      padding: '16px 16px 10px',
      boxShadow: '0 1px 4px rgba(0,0,0,0.07)',
      marginTop: '16px',
    }}>
      {/* Cabeçalho */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' }}>
        <p style={{ margin: 0, fontSize: '11px', fontWeight: '700', color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          📊 {titulo}
        </p>
        {showTendencia && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            {r2 > 0 && (
              <span style={{ fontSize: '10px', color: '#9ca3af' }}>
                ajuste R²={r2.toFixed(2)}
              </span>
            )}
            {crescendo !== null && inclinacaoMensal !== 0 && (
              <span style={{
                fontSize: '11px', fontWeight: '600', padding: '3px 9px',
                borderRadius: '20px',
                background: crescendo ? '#dcfce7' : '#fee2e2',
                color:      crescendo ? '#16a34a' : '#dc2626',
              }}>
                {crescendo ? '▲' : '▼'} {moedaCompacta(Math.abs(inclinacaoMensal))}/mês
              </span>
            )}
          </div>
        )}
      </div>

      {/* Gráfico */}
      <ResponsiveContainer width="100%" height={230}>
        <ComposedChart data={dadosExibidos} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />

          <XAxis
            dataKey="label"
            tick={({ x, y, payload }) => {
              const item = dadosExibidos.find(d => d.label === payload.value);
              return (
                <text x={x} y={y + 10} textAnchor="middle" fill={item?.futuro ? '#c4b5fd' : '#9ca3af'} fontSize={10}>
                  {payload.value}
                </text>
              );
            }}
            axisLine={false}
            tickLine={false}
          />

          {/* Teto fixo: evita que tendência futuras muito altas encolham as barras */}
          <YAxis
            domain={[0, yMax]}
            tickFormatter={moedaCompacta}
            tick={{ fontSize: 10, fill: '#9ca3af' }}
            axisLine={false}
            tickLine={false}
            width={54}
          />

          <Tooltip content={<TooltipCustom />} cursor={{ fill: 'rgba(15,52,96,0.04)' }} />

          {/* Separador entre histórico e projeção */}
          <ReferenceLine
            x={mesAtualLabel}
            stroke="#e5e7eb"
            strokeDasharray="4 3"
            strokeWidth={1.5}
            label={{ value: 'hoje', position: 'top', fontSize: 9, fill: '#d1d5db', dy: -4 }}
          />

          {/* Barras de faturamento — azul escuro (histórico), azul claro (parcial), roxo (projeção) */}
          <Bar
            dataKey="faturamento"
            maxBarSize={36}
            name="Faturamento"
            shape={(props) => {
              const item = dadosExibidos[props?.index];
              return <BarCustomizada {...props} parcial={item?.parcial} projetado={item?.projetado} />;
            }}
          />

          {/* Linha de tendência linear */}
          {temTendencia && showTendencia && (
            <Line
              dataKey="tendencia"
              type="linear"
              stroke="#f59e0b"
              strokeWidth={2}
              dot={({ cx, cy, index }) => {
                const item = dadosExibidos[index];
                if (!item?.futuro) return null;
                return (
                  <circle key={`dot-${index}`} cx={cx} cy={cy} r={4}
                    fill="#6366f1" stroke="#fff" strokeWidth={2} />
                );
              }}
              activeDot={{ r: 4 }}
              connectNulls
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>

      {/* Legenda */}
      <div style={{ display: 'flex', gap: '14px', alignItems: 'center', marginTop: '8px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <div style={{ width: '12px', height: '12px', background: '#0f3460', borderRadius: '2px', flexShrink: 0 }} />
          <span style={{ fontSize: '10px', color: '#9ca3af' }}>Faturamento</span>
        </div>
        {projecaoMesAtual !== null ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <div style={{ width: '12px', height: '12px', background: '#6366f1', borderRadius: '2px', flexShrink: 0 }} />
            <span style={{ fontSize: '10px', color: '#9ca3af' }}>Projeção mês atual</span>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <div style={{ width: '12px', height: '12px', background: '#93c5fd', borderRadius: '2px', flexShrink: 0 }} />
            <span style={{ fontSize: '10px', color: '#9ca3af' }}>Mês parcial</span>
          </div>
        )}
        {temTendencia && showTendencia && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <svg width="22" height="12" style={{ flexShrink: 0 }}>
              <line x1="0" y1="6" x2="22" y2="6" stroke="#f59e0b" strokeWidth="2" />
            </svg>
            <span style={{ fontSize: '10px', color: '#9ca3af' }}>Tendência</span>
          </div>
        )}
        {temTendencia && showTendencia && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <svg width="22" height="12" style={{ flexShrink: 0 }}>
              <line x1="0" y1="6" x2="22" y2="6" stroke="#f59e0b" strokeWidth="2" />
              <circle cx="11" cy="6" r="4" fill="#6366f1" stroke="#fff" strokeWidth="1.5" />
            </svg>
            <span style={{ fontSize: '10px', color: '#9ca3af' }}>Projeção (2 meses)</span>
          </div>
        )}
      </div>
    </div>
  );
}
