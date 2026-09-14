import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { icons } from '@/lib/icons';
import { cn } from '@/lib/utils';

export default function PlanCard({ plan, t, onDecide, showApplyAll, onApplyAll }) {
  const WarningIcon = icons.warning;
  const ClockIcon = icons.clock;
  const CheckIcon = icons.check;
  const CloseIcon = icons.close;

  const preview = plan.preview || {};
  const rows = preview.rows || [];
  const notes = preview.notes || [];
  const counts = Object.entries(preview.counts || {}).filter(([, value]) => value !== undefined && value !== null);

  return (
    <Card
      data-plan-id={plan.id}
      className={cn('gap-2 py-2', plan.destructive && 'border-destructive/40 bg-destructive/5')}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          {plan.destructive ? (
            <WarningIcon className="text-destructive size-3.5 shrink-0" />
          ) : (
            <ClockIcon className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <span>{plan.label}</span>
        </CardTitle>
        <CardDescription>{preview.summary}</CardDescription>
      </CardHeader>

      {rows.length ? (
        <CardContent className="overflow-x-auto">
          <table className="w-full border-collapse text-[11px]">
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b last:border-0">
                  <td className="text-muted-foreground py-1 pr-2 align-top whitespace-nowrap">{row.label}</td>
                  <td className="py-1 pr-2 align-top">
                    {row.cells.map((cell, cellIndex) => (
                      <div key={cellIndex} className="text-muted-foreground line-through">
                        {cell.before === '' ? t('bridge.preview.empty') : cell.before}
                      </div>
                    ))}
                  </td>
                  <td className="py-1 align-top">
                    {row.cells.map((cell, cellIndex) => (
                      <div key={cellIndex}>{cell.after}</div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      ) : null}

      {counts.length ? (
        <CardContent className="flex flex-wrap gap-1">
          {counts.map(([key, value]) => (
            <Badge key={key} variant="secondary">
              {key}: {String(value)}
            </Badge>
          ))}
        </CardContent>
      ) : null}

      {notes.length ? (
        <CardContent>
          <ul className="text-destructive list-disc space-y-0.5 pl-4 text-[11px]">
            {notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </CardContent>
      ) : null}

      <CardFooter className="flex-wrap gap-1.5">
        <Button
          size="sm"
          variant={plan.destructive ? 'destructive' : 'default'}
          onClick={() => onDecide(plan.id, 'apply')}
        >
          <CheckIcon />
          {t(plan.destructive ? 'plan.applyRisky' : 'plan.apply')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onDecide(plan.id, 'reject')}>
          <CloseIcon />
          {t('plan.cancel')}
        </Button>
        {showApplyAll ? (
          <Button size="sm" variant="ghost" onClick={onApplyAll}>
            {t('plan.applyAll')}
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}
