"use client";
import type { Condition } from "spec";

export function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: Condition;
  onChange: (next: Condition) => void;
  onRemove: (id: string) => void;
}) {
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
      <button type="button" aria-label={`remove condition ${condition.id}`} onClick={() => onRemove(condition.id)}>
        Remove
      </button>
    </fieldset>
  );
}
