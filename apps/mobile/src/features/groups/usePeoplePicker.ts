import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getClient, hasClient, searchProfiles, type ProfileMatch } from '@kola/api';

import { getDatabase } from '../../db/client';
import { profiles as profilesTable } from '../../db/schema';

/**
 * Sélecteur de personnes pour la création d'un groupe (#37).
 *
 * Chercher quelqu'un qu'on ne connaît pas est, par nature, une opération en
 * ligne : on interroge un annuaire qu'on n'a pas. C'est la seule exception au
 * local-first (ADR-0002), et elle est bornée — hors ligne, l'écran continue de
 * proposer les personnes déjà présentes dans la base locale, celles avec qui on
 * a déjà échangé. C'est précisément le cas d'usage d'une équipe ou d'une
 * tontine : on refait un groupe avec des gens qu'on connaît déjà.
 *
 * La découverte par carnet d'adresses arrive en #68.
 */

export interface Person {
  readonly id: string;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  /** Vrai si la personne vient de la base locale plutôt que du serveur. */
  readonly known: boolean;
}

export interface PeoplePicker {
  readonly query: string;
  readonly setQuery: (value: string) => void;
  readonly results: readonly Person[];
  readonly isSearching: boolean;
  /** Vrai quand la recherche en ligne a échoué : l'écran reste utilisable. */
  readonly isOffline: boolean;
  readonly selected: readonly Person[];
  readonly toggle: (person: Person) => void;
  readonly isSelected: (id: string) => boolean;
}

/** Frappe au clavier : on n'interroge pas le serveur à chaque lettre. */
const DEBOUNCE_MS = 350;

function readLocalPeople(currentUserId: string | null): readonly Person[] {
  const rows = getDatabase().select().from(profilesTable).all();
  return rows
    .filter((row) => row.id !== currentUserId)
    .map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      known: true,
    }));
}

function matches(person: Person, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  return (
    (person.username ?? '').toLowerCase().includes(needle) ||
    (person.displayName ?? '').toLowerCase().includes(needle)
  );
}

export function usePeoplePicker(currentUserId: string | null): PeoplePicker {
  const [query, setQuery] = useState('');
  // Le résultat porte la requête qui l'a produit. Sans cela, il faudrait le
  // vider depuis l'effet — un `setState` synchrone qui provoque un rendu en
  // cascade — et les résultats d'une frappe précédente s'afficheraient un
  // instant sous la nouvelle.
  const [remote, setRemote] = useState<{ query: string; people: readonly Person[] }>({
    query: '',
    people: [],
  });
  const [searchingFor, setSearchingFor] = useState<string | null>(null);
  const [offlineFor, setOfflineFor] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly Person[]>([]);

  const trimmed = query.trim();
  const local = useMemo(() => readLocalPeople(currentUserId), [currentUserId]);

  // Numéro de la recherche en cours : une réponse lente ne doit pas écraser le
  // résultat d'une frappe plus récente.
  const generation = useRef(0);

  useEffect(() => {
    const needle = query.trim();
    // Deux lettres au minimum : à une seule, la recherche rend la moitié de
    // l'annuaire pour un résultat inutile, sur un forfait qui se compte.
    if (needle.length < 2 || !hasClient()) {
      return;
    }

    const current = ++generation.current;

    const handle = setTimeout(() => {
      setSearchingFor(needle);
      void searchProfiles(getClient(), needle)
        .then((found: readonly ProfileMatch[]) => {
          if (current !== generation.current) {
            return;
          }
          setRemote({
            query: needle,
            people: found.map((match) => ({
              id: match.id,
              username: match.username,
              displayName: match.displayName,
              avatarUrl: match.avatarUrl,
              known: false,
            })),
          });
          setOfflineFor(null);
        })
        .catch(() => {
          if (current !== generation.current) {
            return;
          }
          // L'écran reste utilisable : pas d'erreur affichée, on se rabat sur
          // les personnes déjà connues localement.
          setRemote({ query: needle, people: [] });
          setOfflineFor(needle);
        })
        .finally(() => {
          if (current === generation.current) {
            setSearchingFor(null);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(handle);
    };
  }, [query]);

  const results = useMemo(() => {
    // Les personnes déjà connues passent devant : ce sont celles avec qui on a
    // déjà échangé, donc les plus probables.
    const seen = new Set<string>();
    const ordered: Person[] = [];

    for (const person of local.filter((p) => matches(p, query))) {
      seen.add(person.id);
      ordered.push(person);
    }
    // Le résultat distant n'est repris que s'il correspond à la frappe en
    // cours : sinon on afficherait la réponse à une question déjà changée.
    if (remote.query === query.trim()) {
      for (const person of remote.people) {
        if (!seen.has(person.id)) {
          ordered.push(person);
        }
      }
    }
    return ordered;
  }, [local, query, remote]);

  const toggle = useCallback((person: Person) => {
    setSelected((current) =>
      current.some((p) => p.id === person.id)
        ? current.filter((p) => p.id !== person.id)
        : [...current, person],
    );
  }, []);

  const isSelected = useCallback(
    (id: string) => selected.some((person) => person.id === id),
    [selected],
  );

  return {
    query,
    setQuery,
    results,
    isSearching: searchingFor !== null,
    isOffline: offlineFor !== null && offlineFor === trimmed,
    selected,
    toggle,
    isSelected,
  };
}
