import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { icons } from '@/lib/icons';
import { cn } from '@/lib/utils';

const RELATIVE_UNITS = [
  { limit: 60, divisor: 1, unit: 'second' },
  { limit: 3600, divisor: 60, unit: 'minute' },
  { limit: 86400, divisor: 3600, unit: 'hour' },
  { limit: 604800, divisor: 86400, unit: 'day' },
];

const GROUP_ORDER = ['today', 'yesterday', 'week', 'older'];

export function relativeTime(iso, locale) {
  if (!iso) return '';
  const diffSeconds = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  const entry = RELATIVE_UNITS.find((candidate) => diffSeconds < candidate.limit) || {
    divisor: 604800,
    unit: 'week',
  };
  const value = Math.max(1, Math.round(diffSeconds / entry.divisor));
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-value, entry.unit);
  } catch (err) {
    return new Date(iso).toLocaleString();
  }
}

/** Calendar bucket of a chat, so the drawer reads like Gemini's Recents list. */
export function bucketOf(iso, now) {
  const reference = now ? new Date(now) : new Date();
  const date = iso ? new Date(iso) : new Date(0);
  if (Number.isNaN(date.getTime())) return 'older';
  const startOfDay = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(reference) - startOfDay(date)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return 'week';
  return 'older';
}

/** Splits sessions into Today / Yesterday / Previous 7 days / Older, dropping empty groups. */
export function groupSessions(sessions, now) {
  const buckets = new Map(GROUP_ORDER.map((key) => [key, []]));
  for (const session of sessions || []) {
    buckets.get(bucketOf(session.updatedAt, now)).push(session);
  }
  return GROUP_ORDER.map((key) => ({ key, sessions: buckets.get(key) })).filter((group) => group.sessions.length);
}

function turnsOf(session) {
  if (typeof session.turnCount === 'number') return session.turnCount;
  return typeof session.messageCount === 'number' ? session.messageCount : 0;
}

/** Left slide-over listing saved chat sessions, grouped by date like Gemini's Recents. */
export default function HistoryDrawer({
  t,
  locale,
  open,
  sessions,
  activeSessionId,
  onOpenChange,
  onSelect,
  onDelete,
  onNewChat,
}) {
  const HistoryIcon = icons.history;
  const NewChatIcon = icons.newChat;
  const CloseIcon = icons.close;
  const TrashIcon = icons.trash;
  const groups = groupSessions(sessions);

  return (
    <Dialog open={open} onOpenChange={(value) => onOpenChange(value)}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        data-testid="history-panel"
        /* DialogContent is a centred grid dialog; this panel must be a plain flex column instead,
           otherwise the grid stretches each row and the content overflows the 240px panel. */
        style={{ display: 'flex', flexDirection: 'column' }}
        className="left-0 top-0 h-full max-h-full w-64 max-w-[85vw] translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none rounded-r-lg border-r bg-background p-0 shadow-xl"
      >
        <DialogHeader className="flex w-full min-w-0 shrink-0 flex-row items-center justify-between gap-2 border-b px-2.5 py-2">
          <DialogTitle className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
            <HistoryIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="truncate">{t('history.title')}</span>
          </DialogTitle>
          <div className="flex shrink-0 items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={t('header.newChat')} onClick={onNewChat}>
                  {NewChatIcon ? <NewChatIcon /> : null}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('header.newChat')}</TooltipContent>
            </Tooltip>
            <Button variant="ghost" size="icon-xs" aria-label={t('settings.close')} onClick={() => onOpenChange(false)}>
              <CloseIcon />
            </Button>
          </div>
        </DialogHeader>
        <DialogDescription className="sr-only">{t('history.title')}</DialogDescription>

        <ScrollArea className="min-h-0 w-full min-w-0 flex-1">
          {groups.length === 0 ? (
            <p className="text-muted-foreground px-3 py-3 text-[11px]">{t('history.empty')}</p>
          ) : (
            <div className="w-full min-w-0 pb-2">
              {groups.map((group) => (
                <section key={group.key} className="w-full min-w-0">
                  <h3 className="text-muted-foreground px-3 pt-2.5 pb-1 text-[10px] font-medium tracking-wide uppercase">
                    {t(`history.group.${group.key}`)}
                  </h3>
                  <ul className="flex w-full min-w-0 flex-col gap-px px-1.5">
                    {group.sessions.map((session) => {
                      const isActive = session.id === activeSessionId;
                      return (
                        <li key={session.id} className="w-full min-w-0">
                          <div
                            className={cn(
                              'group flex w-full min-w-0 items-center gap-1 overflow-hidden rounded-md pr-0.5 pl-2',
                              isActive ? 'bg-accent' : 'hover:bg-accent/50',
                            )}
                          >
                            <span
                              aria-hidden="true"
                              className={cn(
                                'size-1.5 shrink-0 rounded-full',
                                isActive ? 'bg-primary' : 'bg-transparent',
                              )}
                            />
                            <button
                              type="button"
                              onClick={() => onSelect(session.id)}
                              className="min-w-0 flex-1 py-1.5 text-left"
                              title={session.title}
                            >
                              <span className="block truncate text-xs leading-tight">{session.title}</span>
                              <span className="text-muted-foreground mt-0.5 block truncate text-[10px] leading-tight">
                                {relativeTime(session.updatedAt, locale)} ·{' '}
                                {t(turnsOf(session) === 1 ? 'history.turn' : 'history.turns', { count: turnsOf(session) })}
                              </span>
                            </button>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={t('history.delete')}
                                  onClick={() => onDelete(session.id)}
                                  className={cn(
                                    'shrink-0 transition-opacity',
                                    isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-70 focus-visible:opacity-70',
                                  )}
                                >
                                  {TrashIcon ? <TrashIcon /> : null}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t('history.delete')}</TooltipContent>
                            </Tooltip>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
