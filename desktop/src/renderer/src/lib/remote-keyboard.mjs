// Нажатие клавиши у оператора → событие ввода для машины сотрудника.
//
// Два разных случая:
//   • печатный символ без Ctrl/Alt уходит ТЕКСТОМ — у сотрудника печатается
//     ровно то, что набрал оператор, какая бы раскладка ни стояла у каждого;
//   • сочетания и служебные клавиши уходят ФИЗИЧЕСКОЙ клавишей (code). Раньше
//     уходил символ, и Ctrl+C на русской раскладке становился «Ctrl+с».

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Fn']);

export function keyEventToInput(e) {
  if (!e || e.isComposing) return null;
  const key = typeof e.key === 'string' ? e.key : '';
  if (!key || key === 'Dead' || key === 'Unidentified' || key === 'Process') return null;
  if (MODIFIER_KEYS.has(key)) return null;
  // Сочетания с Win у оператора перехватывает его собственная система.
  if (e.metaKey) return null;

  // AltGr на европейских раскладках приходит как Ctrl+Alt, но печатает символ.
  const altGraph = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
  const printable = [...key].length === 1;

  if (printable && (altGraph || (!e.ctrlKey && !e.altKey))) {
    return { type: 'text', text: key };
  }

  if (typeof e.code !== 'string' || !e.code) return null;
  return {
    type: 'key',
    code: e.code,
    key,
    ctrl: Boolean(e.ctrlKey),
    alt: Boolean(e.altKey),
    shift: Boolean(e.shiftKey)
  };
}
