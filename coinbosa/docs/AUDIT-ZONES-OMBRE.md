# Audit — zones d'ombre, 16 août 2026

Passe adversarial sur le code **tel qu'il est** sur `coinbosa-genesis-bos20`
(après 52 commits post-`master`). Chaque trouvaille a été relue contre le code
et, pour le consensus, contre `parlia.go`. Ce document ne remplace pas un audit
externe.

**36 contrôles ciblés → 11 confirmés → 8 corrigés ici, 3 consignés comme limites
figées (bytecode du bloc 0).**

---

## Corrigé dans cette passe

| Sévérité | Zone d'ombre | Correctif |
|---|---|---|
| **Majeur (docs)** | `SECURITY-HARDENING.md` affirmait encore que le contrat exige le **`GOVERNOR` dans le set**. C'est faux depuis la séparation gouverneur / scellage. Suivre ce texte aurait ajouté une adresse **incapable de sceller** — le scénario d'arrêt N=2 reproduite dans `coinbosa_halt_repro_test.go`. | Texte aligné : c'est `INITIAL_VALIDATOR` qui doit rester ; la liveness n'est **pas** garantie par le contrat. |
| **Majeur (docs)** | `GENESIS-PRODUCTION.md` ouvrait sur « les 700 M n'existent pas encore » et « 13 adresses à `0x0` ». Le genesis de production **est** produit, l'empreinte figée, les adresses renseignées. Un opérateur lisant ce NO-GO aurait cru la chaîne non lancée. | En-tête remplacé par l'état **du dépôt** (empreinte, validateur, gouverneur), sans prétendre au runtime. |
| **Majeur (ops)** | `check-supply.js` comparait encore poste par poste au genesis **après repli sur `latest`**. Dès qu'une trésorerie bouge, le contrôle échoue sur une chaîne saine. L'en-tête du fichier mentait encore (« lus AU BLOC 0 »). | Au bloc 0 : strict. Au bloc courant : avertissement si les postes ont bougé ; échec seulement si plus de 700 M sur ces adresses, pont non vide, ou bytecode inter-chaînes. |
| Mineur | `finishMinting()` pouvait être rappelé et réémettre `MintingFinished`. | `require(!_mintingFinished)`. |
| Mineur | `rotate-validators.js` affichait « SIMULATION PASSE » même si `eth_call` n'avait pas tourné. | Refus dur si la simulation est absente. |
| Mineur | Explorateur : listait RelayerHub / TokenManager / CrossChain, **sans code** depuis la purge. | Liste limitée aux contrats réellement présents. |
| Reco | Commentaire de `updateValidatorSet` : « garantit un signataire ». Faux (voir halt repro). | Commentaire rectifié. **Logique inchangée** (`bytecodeHash: 'none'`). |
| Reco | Aucun banc du contrat système hors franchissement d'epoch. | `scripts/test-validatorset.js` + étape CI (init idempotent, deposit/reward sans revert, rotation refusée sans genèse / hors gouverneur). |
| Reco | Banc BRC20 : pas de cas `decreaseAllowance` sous zéro, mint/approve vers zéro, burn excessif, `finishMinting` doublon, `transferOwnership(0)`. | Ajoutés. |

---

## Limites figées — le bytecode du bloc 0 ne se corrige plus

Le contrat `CoinbosaValidatorSet` est embarqué dans le genesis. Changer sa **logique**
changerait le `stateRoot`, donc l'identité de la chaîne. Conséquences à vivre avec :

### 1. La clé du gouverneur est irremplaçable

`GOVERNOR` est `constant`. Perte → set de validateurs figé à vie. Compromission →
contrôle du consensus + `sweepSurplus`. Détail : `docs/GENESIS-PRODUCTION.md`.

### 2. Le validateur de genèse ne peut jamais sortir du set

Garde utile contre un set vide de scelleurs, **et** contrainte : une clé de genèse
compromise reste dans le quorum pour toujours. On peut ajouter des validateurs, pas
retirer celui-là.

### 3. `SlashIndicator` (0x…1001) est de l'héritage BSC, incompatible

Le client Parlia appelle encore `slash()` sur 0x…1001 quand un validateur rate son
tour. Ce contrat appelle ensuite `misdemeanor` / `felony` sur 0x…1000 — **fonctions
absentes** de `CoinbosaValidatorSet` (pas de fallback). L'appel revert. Côté Go,
l'erreur est **journalisée, pas fatale** (`parlia.go` Finalize / FinalizeAndAssemble) :
la chaîne continue, **sans sanction**.

À N=1, `slash` n'est de toute façon jamais déclenché (le seul validateur est toujours
in-turn). Dès N≥2, un validateur fautif n'est pas pénalisé. C'est déjà dit dans
`AGENTS.md` (« aucun mécanisme de sanction ») ; ce qui manquait, c'est **pourquoi**
l'héritage ne sauve pas : le contrat de slash est là, et il est mort.

Ne pas « réparer » 0x…1000. La couche d'enjeu ira dans un **autre** contrat.

### 4. Un seul validateur = réorganisation triviale

Inchangé. À dire publiquement tant que N=1.

---

## Vérifié, pas un bug

| Sujet | Verdict |
|---|---|
| `init()` de `CoinbosaValidatorSet` idempotent | Confirmé. Un `require(!alreadyInit)` suiciderait le bloc 1. |
| Frais EIP-1559 | **Pas brûlés.** `state_transition.go` crédite `SystemAddress` ; Kepler actif envoie le tout au validateur via `deposit()`. L'offre native ne diminue pas. |
| `claim()` | Checks-effects-interactions : solde mis à 0 avant le `call`. |
| `deposit()` payable par n'importe qui | Inoffensif ; l'offre fixe rend l'overflow `unchecked` inaccessible. |
| XSS explorateur `name()`/`symbol()` | `esc()` en place ; CSP `script-src 'self'`. |
| `?rpc=` | Restreint à localhost. |
| Site, `coque.py` | Contrôle de cohérence déjà en CI. |
| Halt 1→2 validateurs | Reproduit et gardé (`coinbosa_halt_repro_test.go` + `rotate-validators.js`). |
| Portail de migration | Marqué non fonctionnel, n'envoie rien. |

---

## Hors correctif de fichier (déjà connu, toujours vrai)

- **Go 1.25.12** : 7 failles atteignables de la bibliothèque standard. Correctif déjà
  ouvert : PR #3 (`toolchain go1.25.13`). Ne pas improviser le redéploiement du
  validateur.
- Dérogations `go-vuln-allowlist.json` : expirent le **2026-10-06**.
- Pas de signeur distant / HSM : la clé de scellage est déverrouillée dans le
  processus validateur (isolé du RPC, utilisateur dédié).
- Pas d'audit **externe**.
- BRC20 de référence : pas de plafond de mint (le coin natif n'est pas concerné).

---

## Ce que cette passe a réellement exécuté

| Contrôle | Résultat |
|---|---|
| `python3 coinbosa/site/coque.py --verifier` | 5 pages, aucun défaut |
| `node --check` des scripts JS touchés | OK |
| `go test ./consensus/parlia -run Coinbosa` | `ok` — halt 1→2 confirmé |
| `node scripts/compile.js` (solc 0.8.26) | 0 avertissement ; BRC20 / ValidatorSet / ExampleToken compilent |
| Banc BRC20 + ValidatorSet + epoch | **CI** (nœud réel) — pas simulé ici |

Le banc epoch (~200 blocs × 5 s) et les tests on-chain tournent en intégration continue
sur chaque PR, pas en local dans cette passe.
