import { useStudio } from '../../store/store';
import * as A from '../../store/actions';
import { openMenuAt, promptText, confirmDialog, type MenuItem } from '../components/Menu';

export function patternMenu(): MenuItem[] {
  const s = useStudio.getState();
  const p = s.project;
  const cur = p.patterns.find((x) => x.id === s.patternId);
  return [
    ...p.patterns.map((pt, i) => ({
      label: `${i + 1}. ${pt.name}`,
      color: pt.color,
      checked: pt.id === s.patternId,
      onClick: () => A.selectPattern(pt.id),
    })),
    { separator: true },
    { label: 'New pattern', shortcut: 'F4', onClick: () => A.addPattern() },
    { label: 'Clone pattern', disabled: !cur, onClick: () => cur && A.clonePattern(cur.id) },
    { label: 'Rename pattern…', disabled: !cur, onClick: () => cur && promptText('Rename pattern', cur.name, (v) => v && A.setPattern(cur.id, { name: v })) },
    {
      label: 'Delete pattern',
      danger: true,
      disabled: !cur || p.patterns.length <= 1,
      onClick: () => cur && confirmDialog('Delete pattern', `Delete "${cur.name}" and remove its clips from the playlist?`, () => A.deletePattern(cur.id), 'Delete'),
    },
  ];
}

export function PatternPicker({ compact }: { compact?: boolean }) {
  const project = useStudio((s) => s.project);
  const patternId = useStudio((s) => s.patternId);
  const idx = project.patterns.findIndex((p) => p.id === patternId);
  const cur = project.patterns[idx];
  const step = (d: number) => {
    const n = project.patterns.length;
    if (!n) return;
    A.selectPattern(project.patterns[(idx + d + n) % n].id);
  };
  return (
    <div className={'pattern-picker' + (compact ? ' compact' : '')} onWheel={(e) => step(e.deltaY > 0 ? 1 : -1)}>
      <button className="pp-arrow" onClick={() => step(-1)} title="Previous pattern">
        ‹
      </button>
      <button className="pp-name" onClick={(e) => openMenuAt(e.currentTarget, patternMenu())} title="Select pattern (scroll to switch)">
        <i style={{ background: cur?.color }} />
        {cur ? `${idx + 1}. ${cur.name}` : '—'}
      </button>
      <button className="pp-arrow" onClick={() => step(1)} title="Next pattern">
        ›
      </button>
      <button className="pp-add" title="New pattern" onClick={() => A.addPattern()}>
        +
      </button>
    </div>
  );
}
