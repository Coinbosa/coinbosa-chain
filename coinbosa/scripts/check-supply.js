// Vérifie que l'offre native inscrite au genesis vaut exactement l'offre attendue.
//
// Lecture préférée : AU BLOC 0. Cela reflète l'allocation initiale, sans être
// faussé par les mouvements ultérieurs, et compare le genesis DÉPLOYÉ au fichier
// local, adresse par adresse.
//
// Si l'état du bloc 0 a été purgé (nœud non-archive), on bascule au bloc courant.
// Dans ce mode on NE compare PLUS les soldes poste par poste : les trésoreries
// peuvent avoir bougé, et un écart n'est plus une preuve d'émission. L'allocation
// initiale reste prouvée par le stateRoot (check-genesis-hash.js). Ici on vérifie
// encore que le pont est vide et que les contrats inter-chaînes n'ont pas de code.
//
// Garanti : aucun solde hérité (le pont du réseau amont, notamment) ne subsiste,
// la répartition boucle sur le total, les contrats inter-chaînes sont sans code.
// Limite assumée : ce contrôle itère les adresses du FICHIER local. Une adresse CACHÉE,
// présente dans le genesis déployé mais absente du fichier, lui échapperait — aucune API
// JSON-RPC standard ne permet d'énumérer tous les comptes d'un état.
// C'est scripts/check-genesis-hash.js qui couvre ce cas : il compare le hash et le
// stateRoot du bloc 0 à une empreinte figée, et le stateRoot engage TOUT l'état initial.
// Les deux contrôles sont complémentaires — lancer les deux.
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = process.env.RPC || 'http://127.0.0.1:8545';
// Le fichier genesis à vérifier est paramétrable : la production vise genesis-coinbosa.json,
// la vérification mécanique (CI/local) vise genesis-coinbosa-dev.json via la variable GENESIS.
const GENESIS_FILE = process.env.GENESIS || path.join(__dirname, '..', 'genesis', 'genesis-coinbosa.json');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'coinbosa.config.json'), 'utf8'));
const genesis = JSON.parse(fs.readFileSync(GENESIS_FILE, 'utf8'));

// Refus dur PAR DÉFAUT : un genesis de développement (adresses synthétiques, validateur
// crédité) ne doit jamais passer pour un genesis de production. La seule dérogation est
// une vérification mécanique EXPLICITE (ALLOW_DEV_SUPPLY=1) : elle prouve que la tuyauterie
// offre/pont fonctionne, sans jamais valider un genesis de dev comme production.
const ALLOW_DEV_SUPPLY = process.env.ALLOW_DEV_SUPPLY === '1';
if (genesis.coinbosaDev && !ALLOW_DEV_SUPPLY) {
  console.error(`ECHEC : ${path.basename(GENESIS_FILE)} porte le marqueur coinbosaDev — genesis de DÉVELOPPEMENT, non déployable en production.`);
  process.exit(1);
}
if (genesis.coinbosaDev) {
  console.warn("⚠  MODE DÉVELOPPEMENT (ALLOW_DEV_SUPPLY=1) : contrôle mécanique sur un genesis de DÉV — NON valable comme preuve de production.");
}

const EXPECTED = BigInt(config.nativeCoin.totalSupply) * 10n ** 18n;

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);

  // Sur quel bloc lire les soldes ?
  // L'état du bloc 0 finit par être PURGÉ : geth ne conserve l'état historique que sur une
  // fenêtre glissante. Le bloc 0 reste lisible en en-tête, mais plus en état — donc plus
  // interrogeable pour un solde. Ce n'est pas une perte de vérifiabilité : le stateRoot du
  // bloc 0 est publié dans genesis-reference.json et engage TOUTE l'allocation initiale ;
  // c'est check-genesis-hash.js qui le prouve. Ici on mesure l'offre RÉELLE d'aujourd'hui,
  // ce qui est la question complémentaire : rien n'a-t-il été créé depuis ?
  let BLOC = 0;
  try {
    await provider.getBalance('0x0000000000000000000000000000000000000001', 0);
  } catch (e) {
    if (/historical state|missing trie node|not available/i.test(e.message || '')) {
      BLOC = 'latest';
      console.log('  (état du bloc 0 purgé — lecture au bloc courant ; l\'allocation initiale');
      console.log('   est prouvée par le stateRoot publié, via check-genesis-hash.js)');
    } else throw e;
  }

  let total = 0n;
  const mismatches = [];
  for (const [addr, v] of Object.entries(genesis.alloc)) {
    const declared = v.balance ? BigInt(v.balance) : 0n;
    if (declared === 0n) continue;
    const onchain = await provider.getBalance(addr, BLOC); // au bloc retenu
    if (onchain !== declared) mismatches.push({ addr, declared, onchain });
    total += onchain;
  }
  const lectureGenesis = BLOC === 0;

  // le contrat de pont hérité doit être vide en solde ET purgé de son bytecode
  const bridge = await provider.getBalance('0x0000000000000000000000000000000000001004', BLOC);
  const XCHAIN = ['0x0000000000000000000000000000000000001003','0x0000000000000000000000000000000000001004',
                  '0x0000000000000000000000000000000000001005','0x0000000000000000000000000000000000001006',
                  '0x0000000000000000000000000000000000001008','0x0000000000000000000000000000000000002000'];
  const withCode = [];
  for (const a of XCHAIN) { const c = await provider.getCode(a); if (c && c !== '0x') withCode.push(a); }

  const whole = (x) => (x / 10n ** 18n).toLocaleString('en-US');
  console.log(`  lecture               : ${lectureGenesis ? 'bloc 0 (allocation initiale)' : 'bloc courant (état du bloc 0 purgé)'}`);
  console.log(`  soldes des postes genesis : ${whole(total)} BOSA`);
  console.log(`  attendu au genesis        : ${whole(EXPECTED)} BOSA`);
  console.log(`  pont 0x…1004          : ${whole(bridge)} BOSA`);
  console.log(`  contrats inter-chaînes avec code : ${withCode.length}`);

  let ok = true;
  if (bridge !== 0n) { console.error(`\nECHEC : le pont hérité détient encore ${whole(bridge)} BOSA.`); ok = false; }
  if (withCode.length) { console.error(`\nECHEC : contrats inter-chaînes hérités encore présents (bytecode) : ${withCode.join(', ')}`); ok = false; }

  if (lectureGenesis) {
    // Au bloc 0, tout écart est une erreur d'allocation.
    if (total !== EXPECTED) { console.error(`\nECHEC : offre de ${whole(total)}, attendu ${whole(EXPECTED)}.`); ok = false; }
    if (mismatches.length) {
      console.error('\nECHEC : soldes on-chain divergents du genesis :');
      mismatches.forEach((m) => console.error(`  ${m.addr} : ${whole(m.onchain)} au lieu de ${whole(m.declared)}`));
      ok = false;
    }
  } else {
    // Bloc courant : les trésoreries PEUVENT avoir bougé. Un écart poste par poste
    // n'est plus une preuve d'émission. L'allocation initiale est le stateRoot.
    // En revanche, plus de 700 M sur les seules adresses du genesis serait une
    // création de monnaie — ça, on le refuse encore.
    if (total > EXPECTED) {
      console.error(`\nECHEC : ${whole(total)} BOSA sur les adresses du genesis, plafond ${whole(EXPECTED)}.`);
      ok = false;
    }
    if (mismatches.length) {
      console.warn('\n  (info) soldes courants ≠ allocation du genesis — attendu après usage :');
      mismatches.forEach((m) => console.warn(`    ${m.addr} : ${whole(m.onchain)} (était ${whole(m.declared)})`));
    }
    if (total !== EXPECTED && total <= EXPECTED) {
      console.warn(`  (info) ${whole(total)} BOSA restant sur les postes du genesis ; le reste a quitté ces adresses.`);
      console.warn('  l\'offre initiale est prouvée par check-genesis-hash.js, pas par cette somme.');
    }
  }
  if (!ok) process.exit(1);
  console.log('\n  offre native conforme, contrats inter-chaînes purgés');
})().catch((e) => { console.error('ERREUR :', e.message); process.exit(1); });
