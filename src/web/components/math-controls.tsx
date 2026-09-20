import type { CSSProperties, ChangeEvent } from "react";

import {
  Channel,
  MathOperator,
  MathSource,
  isArithmeticMathOperator,
  type MathState,
} from "../../shared/scope-types.js";
import type { ScopeActions } from "../scope-actions.js";
import { mathAccent } from "../waveform-source-style.js";

interface MathControlsProps {
  math: readonly MathState[];
  actions: ScopeActions;
}

const ARITHMETIC_OPERATORS = [
  MathOperator.Add,
  MathOperator.Subtract,
  MathOperator.Multiply,
  MathOperator.Divide,
] as const;

function operatorLabel(operator: MathOperator): string {
  switch (operator) {
    case MathOperator.Add: return "A + B";
    case MathOperator.Subtract: return "A - B";
    case MathOperator.Multiply: return "A × B";
    case MathOperator.Divide: return "A ÷ B";
    case MathOperator.And: return "A AND B";
    case MathOperator.Or: return "A OR B";
    case MathOperator.Xor: return "A XOR B";
    case MathOperator.Not: return "NOT A";
    case MathOperator.Fft: return "FFT";
    case MathOperator.Integrate: return "Integrate";
    case MathOperator.Differentiate: return "Differentiate";
    case MathOperator.SquareRoot: return "Square root";
    case MathOperator.Log10: return "log10";
    case MathOperator.NaturalLog: return "ln";
    case MathOperator.Exp: return "exp";
    case MathOperator.Abs: return "abs";
    case MathOperator.LowPass: return "Low-pass";
    case MathOperator.HighPass: return "High-pass";
    case MathOperator.BandPass: return "Band-pass";
    case MathOperator.BandStop: return "Band-stop";
    case MathOperator.AxB: return "AX+B";
  }
}

function mathSourceLabel(source: MathSource): string {
  if (source >= MathSource.Ch1 && source <= MathSource.Ch4) return `CH${source}`;
  if (source >= MathSource.Math1 && source <= MathSource.Math4) return `MATH${source - 4}`;
  if (source >= MathSource.Ref1 && source <= MathSource.Ref10) return `REF${source - 100}`;
  return String(source);
}

function editableSources(math: MathState): MathSource[] {
  const values: MathSource[] = [
    MathSource.Ch1,
    MathSource.Ch2,
    MathSource.Ch3,
    MathSource.Ch4,
  ];
  for (let index = 1; index < math.math; index += 1) {
    values.push((MathSource.Math1 + index - 1) as MathSource);
  }
  for (const current of [math.source1, math.source2]) {
    if (current !== null && !values.includes(current)) values.push(current);
  }
  return values;
}

export function MathControls({ math, actions }: MathControlsProps) {
  return (
    <section className="panel">
      <h2>Math</h2>
      <div className="channel-grid">
        {math.map((state) => {
          const editable = isArithmeticMathOperator(state.operator);
          const sources = editableSources(state);
          const style = { "--channel-accent": mathAccent(state.math) } as CSSProperties;
          return (
            <div className="channel-card" style={style} key={state.math}>
              <div className="channel-heading">
                <strong>MATH{state.math}</strong>
                <label>
                  <input
                    type="checkbox"
                    checked={state.enabled}
                    onChange={(event) => void actions.setMathEnabled(state.math, event.target.checked)}
                  />
                  On
                </label>
              </div>
              <label>
                Operation
                <select
                  value={state.operator}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    void actions.setMathOperator(state.math, Number(event.target.value) as MathOperator)
                  }
                >
                  {!editable ? (
                    <option value={state.operator}>{operatorLabel(state.operator)}</option>
                  ) : null}
                  {ARITHMETIC_OPERATORS.map((operator) => (
                    <option value={operator} key={operator}>{operatorLabel(operator)}</option>
                  ))}
                </select>
              </label>
              <label>
                Source A
                <select
                  value={state.source1}
                  disabled={!editable}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    void actions.setMathSource1(state.math, Number(event.target.value) as MathSource)
                  }
                >
                  {sources.map((source) => (
                    <option value={source} key={source}>{mathSourceLabel(source)}</option>
                  ))}
                </select>
              </label>
              <label>
                Source B
                <select
                  value={state.source2 ?? MathSource.Ch1}
                  disabled={!editable}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    void actions.setMathSource2(state.math, Number(event.target.value) as MathSource)
                  }
                >
                  {sources.map((source) => (
                    <option value={source} key={source}>{mathSourceLabel(source)}</option>
                  ))}
                </select>
              </label>
              <label>
                Scale/div
                <input
                  type="number"
                  step="any"
                  value={state.scale ?? ""}
                  disabled={!editable || state.scale === null}
                  onChange={(event) => void actions.setMathScale(state.math, Number(event.target.value))}
                />
              </label>
              <label>
                Offset
                <input
                  type="number"
                  step="any"
                  value={state.offset ?? ""}
                  disabled={!editable || state.offset === null}
                  onChange={(event) => void actions.setMathOffset(state.math, Number(event.target.value))}
                />
              </label>
              {!editable ? (
                <p className="muted">Configured on the scope; this operator is display-only in RigolWeb.</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
