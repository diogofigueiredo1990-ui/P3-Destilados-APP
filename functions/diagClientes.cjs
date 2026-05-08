const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');

const sa = JSON.parse(fs.readFileSync('./serviceAccountKey.json.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

async function main() {
  // 1. Mostra campos de um documento de cliente (amostra)
  console.log('\n=== 1. Campos de um documento clientes (amostra) ===');
  const amostra = await db.collection('clientes').limit(3).get();
  amostra.docs.forEach(d => {
    console.log('DOC ID:', d.id);
    console.log('CAMPOS:', JSON.stringify(d.data(), null, 2).slice(0, 500));
    console.log('---');
  });

  // 2. Busca clientes bloqueados
  console.log('\n=== 2. Clientes com statusBloqueio definido ===');
  const bloqSnap = await db.collection('clientes').where('statusBloqueio', '!=', '').limit(20).get();
  console.log(`Total bloqueados: ${bloqSnap.size}`);
  bloqSnap.docs.forEach(d => {
    const r = d.data();
    const nome = r.nomeEmpresa || r.nome || r.cliente || r.razaoSocial || '(sem nome)';
    console.log(` ${nome} | CNPJ: ${r.cnpj || d.id} | Bloqueio: ${r.statusBloqueio}`);
  });

  // 3. Busca em todos os campos por MCO, RVS, VAN, NILIA
  console.log('\n=== 3. Buscando MCO/RVS/VAN/NILIA em todos os campos de clientes ===');
  const allCli = await db.collection('clientes').get();
  const termos = ['MCO', 'RVS', 'VAN SANTANA', 'NILIA'];
  allCli.docs.forEach(d => {
    const r = d.data();
    const str = JSON.stringify(r).toUpperCase();
    for (const t of termos) {
      if (str.includes(t)) {
        const nome = r.nomeEmpresa || r.nome || r.cliente || r.razaoSocial || '(sem nome)';
        console.log(` ENCONTRADO '${t}': ${nome} | CNPJ: ${r.cnpj || d.id} | Bloqueio: ${r.statusBloqueio}`);
        break;
      }
    }
  });

  // 4. Pedidos de Ana Carolina - clientes únicos com nome contendo esses termos
  console.log('\n=== 4. Pedidos Ana Carolina - busca por nome de cliente ===');
  const pedSnap = await db.collection('pedidos').where('vendedorResponsavel', '==', 'Ana Carolina').get();
  console.log(`Total pedidos Ana Carolina: ${pedSnap.size}`);
  
  const clienteNames = new Set();
  pedSnap.docs.forEach(d => {
    const p = d.data();
    const nome = (p.cliente || '').toUpperCase();
    if (nome.includes('MCO') || nome.includes('RVS') || nome.includes('VAN') || nome.includes('NILIA') || nome.includes('NILIA')) {
      clienteNames.add(`${p.cliente} | CNPJ: ${p.cnpj} | chave: ${p.chave}`);
    }
  });
  console.log('Clientes com esses nomes nos pedidos:');
  clienteNames.forEach(n => console.log(' -', n));

  // 5. Todos os clientes únicos nos pedidos de Ana Carolina com seus CNPJs
  console.log('\n=== 5. Amostra de clientes únicos nos pedidos de Ana Carolina ===');
  const cliUnicosMap = {};
  pedSnap.docs.forEach(d => {
    const p = d.data();
    const cnpj = p.cnpj;
    if (!cliUnicosMap[cnpj]) cliUnicosMap[cnpj] = p.cliente;
  });
  const cliUnicos = Object.entries(cliUnicosMap);
  console.log(`Total: ${cliUnicos.length} clientes únicos`);
  cliUnicos.slice(0, 30).forEach(([cnpj, nome]) => console.log(` ${nome} | ${cnpj}`));
}

main().catch(console.error).finally(() => process.exit());
