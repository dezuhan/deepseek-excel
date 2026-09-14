import { Button } from '@/components/ui/button';

const ACTIONS = [
  { label: 'quick.analysis.label', prompt: 'quick.analysis.prompt' },
  { label: 'quick.format.label', prompt: 'quick.format.prompt' },
  { label: 'quick.table.label', prompt: 'quick.table.prompt' },
  { label: 'quick.chart.label', prompt: 'quick.chart.prompt' },
  { label: 'quick.summary.label', prompt: 'quick.summary.prompt' },
];

export default function QuickActions({ t, disabled, onSelect }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ACTIONS.map((action) => (
        <Button
          key={action.label}
          type="button"
          variant="outline"
          size="xs"
          disabled={disabled}
          onClick={() => onSelect(t(action.prompt))}
        >
          {t(action.label)}
        </Button>
      ))}
    </div>
  );
}
