import { icons } from '@/lib/icons';
import { cn } from '@/lib/utils';

export default function Banner({ banner, t }) {
  if (!banner) return null;
  const Icon = banner.kind === 'error' ? icons.warning : icons.info;
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 border-b px-3 py-2 text-xs',
        banner.kind === 'error'
          ? 'bg-destructive/10 text-destructive border-destructive/30'
          : 'bg-muted text-muted-foreground',
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" />
      <span>{t(banner.key, banner.params)}</span>
    </div>
  );
}
