'use client';

import { type GroupRef } from '@ftms/core';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

/**
 * Searchable multi-select of groups (§6.2). Filtering only hides options, so
 * groups already ticked stay selected (and submitted) while searching.
 */
export function GroupPicker({
  groups,
  selected,
  label,
  hint,
  errors,
  name = 'groupIds',
}: {
  groups: GroupRef[];
  selected: string[];
  label: string;
  hint?: string;
  errors?: string[];
  name?: string;
}) {
  const t = useTranslations('groupPicker');
  const te = useTranslations('errors');
  const id = useId();
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(selected));
  const q = query.trim().toLowerCase();
  const toggle = (groupId: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(groupId);
      else next.delete(groupId);
      return next;
    });

  return (
    <fieldset className={`field group-picker${errors?.length ? ' field-invalid' : ''}`}>
      <legend>{label}</legend>
      {hint && <p className="field-hint">{hint}</p>}
      {groups.length === 0 ? (
        <p className="empty">{t('none')}</p>
      ) : (
        <>
          <div className="actions">
            <label className="sr-only" htmlFor={`${id}-q`}>
              {t('search')}
            </label>
            <input
              id={`${id}-q`}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('search')}
            />
            <span className="muted small" aria-live="polite">
              {t('selected', { count: chosen.size })}
            </span>
          </div>
          <ul className="check-list">
            {groups.map((g) => (
              <li key={g.id} hidden={q !== '' && !g.name.toLowerCase().includes(q)}>
                <label>
                  <input
                    type="checkbox"
                    name={name}
                    value={g.id}
                    checked={chosen.has(g.id)}
                    onChange={(e) => toggle(g.id, e.target.checked)}
                  />
                  {g.name}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {errors && errors.length > 0 && (
        <ul className="field-errors">
          {errors.map((code) => (
            <li key={code}>{te.has(code) ? te(code) : te('field')}</li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
