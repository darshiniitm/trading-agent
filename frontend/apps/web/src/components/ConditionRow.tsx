"use client";
import { useState } from "react";
import type { Condition } from "spec";

// value/params carry whatever shape engine/conditions/catalog.py's CATALOG requires
// per condition (e.g. value: [10000, 50000] for a between op, params: {length, mult,
// source} for vstop) — there is no fixed shape per D6, so these are raw JSON text
// inputs rather than typed fields. Each keeps its own local text so an in-progress,
// momentarily-invalid edit (e.g. typing "[100") never gets clobbered by the parent's
// last-valid-parse, and never propagates upward until it parses.
function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "object" && Object.keys(value as object).length === 0);
}

function useJsonField<T>(initial: T) {
  const [text, setText] = useState(() => (isEmpty(initial) ? "" : JSON.stringify(initial)));
  return { text, setText };
}

export function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: Condition;
  onChange: (next: Condition) => void;
  onRemove: (id: string) => void;
}) {
  const valueField = useJsonField(condition.value);
  const paramsField = useJsonField(condition.params);

  function onValueText(text: string) {
    valueField.setText(text);
    if (text === "") return onChange({ ...condition, value: null });
    try {
      onChange({ ...condition, value: JSON.parse(text) });
    } catch {
      // incomplete/invalid JSON mid-typing — keep the text, don't propagate yet
    }
  }

  function onParamsText(text: string) {
    paramsField.setText(text);
    if (text === "") return onChange({ ...condition, params: {} });
    try {
      onChange({ ...condition, params: JSON.parse(text) });
    } catch {
      // incomplete/invalid JSON mid-typing — keep the text, don't propagate yet
    }
  }

  return (
    <fieldset>
      <legend>{condition.id}</legend>
      <label>
        Role
        <select
          aria-label="role"
          value={condition.role}
          onChange={(e) => onChange({ ...condition, role: e.target.value as Condition["role"] })}
        >
          <option value="filter">filter</option>
          <option value="event">event</option>
          <option value="stop">stop</option>
        </select>
      </label>
      <label>
        Kind
        <select
          aria-label="kind"
          value={condition.kind}
          onChange={(e) => onChange({ ...condition, kind: e.target.value as Condition["kind"] })}
        >
          <option value="field">field</option>
          <option value="indicator">indicator</option>
        </select>
      </label>
      <label>
        Condition name
        <input
          aria-label="condition name"
          value={condition.name}
          onChange={(e) => onChange({ ...condition, name: e.target.value })}
        />
      </label>
      <label>
        Operator
        <input aria-label="operator" value={condition.op} onChange={(e) => onChange({ ...condition, op: e.target.value })} />
      </label>
      <label>
        Direction (flip only)
        <select
          aria-label="direction"
          value={condition.dir ?? ""}
          onChange={(e) => onChange({ ...condition, dir: e.target.value === "long" ? "long" : null })}
        >
          <option value="">—</option>
          <option value="long">long</option>
        </select>
      </label>
      <label>
        Params (JSON)
        <input aria-label="params (JSON)" value={paramsField.text} onChange={(e) => onParamsText(e.target.value)} />
      </label>
      <label>
        Value (JSON)
        <input aria-label="value (JSON)" value={valueField.text} onChange={(e) => onValueText(e.target.value)} />
      </label>
      <button type="button" aria-label={`remove condition ${condition.id}`} onClick={() => onRemove(condition.id)}>
        Remove
      </button>
    </fieldset>
  );
}
