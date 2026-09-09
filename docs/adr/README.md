# Décisions d'architecture

Un ADR (_Architecture Decision Record_) consigne une décision structurante au moment où
elle est prise : le contexte, l'option retenue, celles qui ont été écartées et pourquoi,
et les conséquences assumées.

L'intérêt n'est pas documentaire. Dans six mois, quelqu'un — peut-être nous — voudra
revenir sur un de ces choix. Sans trace écrite, le débat recommence sans mémoire, et
souvent aboutit à la même conclusion après avoir coûté une semaine.

## Règle de mise à jour

**Un ADR ne se réécrit pas.** Quand une décision change, on écrit un nouvel ADR qui
supersède l'ancien, et on marque l'ancien `Remplacé par ADR-XXXX`. L'historique des
décisions est aussi utile que la décision courante : il dit ce qu'on savait à l'époque.

Seules les corrections de forme (fautes, liens morts) se font en place.

## Index

| N°   | Titre                                                                 | Statut  | Date       |
| ---- | --------------------------------------------------------------------- | ------- | ---------- |
| 0001 | [Choix de la stack](0001-choix-de-la-stack.md)                        | Accepté | 2026-09-09 |
| 0002 | [Architecture local-first](0002-architecture-local-first.md)          | Accepté | 2026-09-09 |
| 0003 | [Pas de chiffrement de bout en bout en V1](0003-pas-de-e2ee-en-v1.md) | Accepté | 2026-09-09 |
| 0004 | [Choix de Supabase](0004-choix-de-supabase.md)                        | Accepté | 2026-09-09 |
| 0005 | [Stratégie de release](0005-strategie-de-release.md)                  | Accepté | 2026-09-09 |
| 0006 | [Budget de performance](0006-budget-de-performance.md)                | Accepté | 2026-09-09 |

## Gabarit

```markdown
# ADR-XXXX — Titre à l'infinitif ou au substantif

- **Statut** : Proposé | Accepté | Remplacé par ADR-YYYY | Abandonné
- **Date** : AAAA-MM-JJ
- **Concerne** : #numéros d'issues

## Contexte

Le problème, les contraintes, ce qu'on sait et ce qu'on ignore au moment de décider.

## Décision

Ce qu'on fait. Au présent, à l'affirmative.

## Alternatives écartées

Chaque option sérieusement envisagée, et la raison précise du rejet. Une alternative
sans raison de rejet n'a pas été sérieusement envisagée.

## Conséquences

Ce que cette décision rend facile, ce qu'elle rend difficile, et ce qu'elle interdit.
Y compris ce qui nous déplaît : un ADR qui ne liste que des avantages n'est pas une
décision, c'est une justification.
```
