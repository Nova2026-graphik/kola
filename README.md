# Kola

Messagerie panafricaine — la messagerie personnelle de WhatsApp, les communautés de Discord,
les canaux de Telegram, pensés pour les réseaux d'Afrique de l'Ouest. Premier marché : le Togo.

## Principe directeur

**Local-first.** L'application est pleinement utilisable hors ligne : tout l'historique est lisible,
les messages se rédigent et se mettent en file d'attente, la synchronisation se fait au retour du
réseau. Le réseau est un bonus, pas un prérequis.

## Contraintes

- Réseau lent, cher et intermittent
- Android d'entrée de gamme (2 Go de RAM, Android 9+)
- Économie de données : compression agressive, pas de téléchargement automatique hors Wi-Fi
- Une seule base de code pour iOS et Android

## Structure

```
kola/
├── apps/mobile/            # application Expo (iOS + Android)
├── packages/core/          # types partagés, schémas Zod, constantes
├── packages/api/           # client Supabase typé + repositories
├── packages/ui/            # design system React Native
├── supabase/migrations/    # SQL versionné
├── supabase/functions/     # Edge Functions
├── docs/adr/               # décisions d'architecture
└── .github/workflows/      # CI et release
```

## Statut

En cours d'initialisation — jalon M0 (Fondations).

> ⚠️ Kola n'est **pas** chiffrée de bout en bout en V1. Voir `docs/adr/0003-pas-de-e2ee-en-v1.md`.
