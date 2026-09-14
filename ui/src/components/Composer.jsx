import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { icons } from '@/lib/icons';
import { cn } from '@/lib/utils';

/** Markdown editing actions available above the composer. */
const MARKDOWN_ACTIONS = [
  { key: 'bold', icon: 'bold', wrap: ['**', '**'], keybind: 'b' },
  { key: 'italic', icon: 'italic', wrap: ['*', '*'], keybind: 'i' },
  { key: 'code', icon: 'code', wrap: ['`', '`'], keybind: 'e' },
  { key: 'link', icon: 'link', wrap: ['[', '](https://)'], keybind: 'k' },
  { key: 'bulletList', icon: 'listBullet', prefix: '- ' },
  { key: 'numberedList', icon: 'listNumbered', prefix: '1. ' },
  { key: 'quote', icon: 'quote', prefix: '> ' },
];

const KEYBINDS = new Map(MARKDOWN_ACTIONS.filter((action) => action.keybind).map((action) => [action.keybind, action]));

export default function Composer({
  t,
  busy,
  disabled,
  value,
  onChange,
  focusToken,
  onSend,
  onStop,
  onRefreshContext,
  cost,
  onOpenCost,
}) {
  const textareaRef = useRef(null);
  const pendingSelection = useRef(null);

  const SendIcon = icons.send;
  const StopIcon = icons.stop;
  const RefreshIcon = icons.refresh;
  const BalanceIcon = icons.balance;

  // Compact cost meter shown instead of the Markdown hint: balance then peak status.
  const costData = cost && cost.data ? cost.data : null;
  const peak = costData && costData.peak ? costData.peak : null;
  const balanceInfos =
    costData && costData.balance && Array.isArray(costData.balance.balance_infos) ? costData.balance.balance_infos : null;
  const balanceText =
    balanceInfos && balanceInfos.length ? `${balanceInfos[0].total_balance} ${balanceInfos[0].currency}` : null;
  const balanceLabel = balanceText || (cost && cost.loading ? '…' : t('settings.cost.unavailable'));

  // Restore the caret after a Markdown action rewrote the value through React state.
  useEffect(() => {
    if (!pendingSelection.current || !textareaRef.current) return;
    const { start, end } = pendingSelection.current;
    pendingSelection.current = null;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(start, end);
  }, [value]);

  // Suggested commands focus the composer with the caret at the end, ready to be edited.
  // `value` is intentionally NOT a dependency: re-running this on every keystroke would
  // keep yanking the caret to the end while the user edits the middle of a sentence.
  useEffect(() => {
    if (!focusToken) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    const end = (value || '').length;
    try {
      textarea.setSelectionRange(end, end);
    } catch (err) {
      /* some WebView2 builds reject setSelectionRange before the first paint */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);

  const submit = () => {
    const text = (value || '').trim();
    if (!text || disabled) return;
    onChange('');
    onSend(text);
  };

  function applyEdit(nextValue, start, end) {
    pendingSelection.current = { start, end };
    onChange(nextValue);
  }

  function runAction(action) {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const text = value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = text.slice(start, end);

    if (action.wrap) {
      const [before, after] = action.wrap;
      const inner = selected || t(`composer.mdSample.${action.key}`);
      const next = `${text.slice(0, start)}${before}${inner}${after}${text.slice(end)}`;
      const caretStart = start + before.length;
      applyEdit(next, caretStart, caretStart + inner.length);
      return;
    }

    // Line prefixes toggle on and off for every touched line.
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineEndRaw = text.indexOf('\n', end);
    const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
    const block = text.slice(lineStart, lineEnd);
    const lines = block.split('\n');
    const allPrefixed = lines.every((line) => line.startsWith(action.prefix));
    const nextLines = lines.map((line) => (allPrefixed ? line.slice(action.prefix.length) : `${action.prefix}${line}`));
    const nextBlock = nextLines.join('\n');
    const next = `${text.slice(0, lineStart)}${nextBlock}${text.slice(lineEnd)}`;
    applyEdit(next, lineStart, lineStart + nextBlock.length);
  }

  const onKeyDown = (event) => {
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && KEYBINDS.has(key)) {
      event.preventDefault();
      runAction(KEYBINDS.get(key));
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="bg-card flex flex-col gap-2 border-t px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex items-center gap-0.5">
        {MARKDOWN_ACTIONS.map((action) => {
          const Icon = icons[action.icon];
          const label = t(`composer.md.${action.key}`);
          return (
            <Tooltip key={action.key}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={label}
                  disabled={disabled}
                  onClick={() => runAction(action)}
                >
                  <Icon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {label}
                {action.keybind ? ` (Ctrl+${action.keybind.toUpperCase()})` : ''}
              </TooltipContent>
            </Tooltip>
          );
        })}
        <span className="bg-border mx-1 h-4 w-px" />
      </div>

      {/* Plain input on purpose: no Markdown toggle and no in-place preview. Markdown is only
          rendered after sending (your own bubble) and for the model's answers. */}
      <Textarea
        ref={textareaRef}
        value={value}
        rows={2}
        placeholder={t('composer.placeholder')}
        aria-label={t('composer.placeholder')}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />

      <div className={cn('flex items-center gap-1.5', 'justify-between')}>
        {/* Compact cost meter: balance · peak/off-peak, separated by a middle dot (·). */}
        <button
          type="button"
          data-testid="composer-cost"
          aria-label={t('composer.costMeter')}
          title={t('composer.costMeter')}
          onClick={onOpenCost}
          className="text-muted-foreground hover:text-foreground flex min-w-0 items-center gap-1.5 text-[10px]"
        >
          <BalanceIcon className="size-3 shrink-0" />
          <span className="truncate font-medium" data-testid="composer-balance">
            {balanceLabel}
          </span>
          {peak ? (
            <span className="flex shrink-0 items-center gap-1" data-testid="composer-peak">
              <span aria-hidden="true">·</span>
              <span
                aria-hidden="true"
                className={cn('size-1.5 rounded-full', peak.isPeak ? 'bg-destructive' : 'bg-emerald-500')}
              />
              {peak.isPeak ? t('composer.peak') : t('composer.offPeak')}
            </span>
          ) : null}
        </button>
        <span className="flex items-center gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={onRefreshContext} disabled={disabled}>
            <RefreshIcon />
            {t('composer.context')}
          </Button>
          {busy ? (
            <Button type="button" variant="outline" size="sm" onClick={onStop}>
              <StopIcon />
              {t('composer.stop')}
            </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={disabled || !value.trim()}>
            <SendIcon />
            {t('composer.send')}
          </Button>
        </span>
      </div>
    </form>
  );
}
