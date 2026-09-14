import { useStore, useI18n } from '@/lib/store';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import Header from '@/components/Header';
import Banner from '@/components/Banner';
import Chat from '@/components/Chat';
import Composer from '@/components/Composer';
import HistoryDrawer from '@/components/HistoryDrawer';
import SettingsPage from '@/components/SettingsPage';
import { icons } from '@/lib/icons';
import { cn } from '@/lib/utils';

/** Thin status line, only rendered while something is not perfectly fine. */
function StatusLine({ t, state }) {
  const tone =
    state.statusLevel === 'ok' ? 'bg-emerald-500' : state.statusLevel === 'err' ? 'bg-destructive' : 'bg-amber-500';
  return (
    <div className="bg-muted/40 text-muted-foreground flex items-center gap-2 border-b px-3 py-1 text-[11px]">
      <span className={cn('size-1.5 shrink-0 rounded-full', tone)} />
      <span className="truncate">{t(state.statusKey, state.statusParams)}</span>
    </div>
  );
}

export default function App({ pane }) {
  const [state] = useStore(pane.store);
  const { t, supported } = useI18n(pane.i18n);
  const locales = supported();
  const disabled = state.phase !== 'ready' || state.busy;

  const UndoIcon = icons.undo;
  const TrashIcon = icons.trash;
  const ResetIcon = icons.reset;

  // Settings is a full page of its own: it replaces the chat shell instead of floating above it.
  if (state.settingsOpen) {
    return (
      <div className="bg-background text-foreground flex h-screen flex-col overflow-hidden">
        <SettingsPage
          t={t}
          state={state}
          page={state.settingsPage}
          locales={locales}
          onNavigate={pane.setSettingsPage}
          onClose={pane.closeSettings}
          onSave={pane.saveSettings}
          onSaveInterface={pane.saveInterface}
          onSavePersonalization={pane.savePersonalization}
          onSavePrompt={pane.savePrompt}
          onResetPrompt={pane.resetPrompt}
          onRefreshCost={pane.refreshCost}
          onFetchMode={pane.setFetchMode}
          onTheme={pane.setThemeMode}
          onAddEntry={pane.addEntry}
          onEditEntry={pane.editEntry}
          onRemoveEntry={pane.removeEntry}
          onApplyPreset={pane.applyPreset}
          onUpdatePersonalization={pane.updatePersonalization}
        />
      </div>
    );
  }

  return (
    <div className="bg-background text-foreground flex h-screen flex-col overflow-hidden">
      <Header
        t={t}
        state={state}
        onToggleHistory={pane.toggleHistory}
        onNewChat={pane.newChat}
        onOpenSettings={pane.openSettings}
      />
      {state.statusLevel !== 'ok' ? <StatusLine t={t} state={state} /> : null}
      <Banner banner={state.banner} t={t} />

      <ScrollArea className="pane-scroll min-h-0 flex-1">
        <div className="flex flex-col gap-2.5 p-3">
          <Chat
            t={t}
            state={state}
            disabled={disabled}
            onDecide={pane.decidePlan}
            onApplyAll={pane.applyAllPlans}
            onSuggest={pane.appendDraft}
          />
        </div>
      </ScrollArea>

      <Composer
        t={t}
        busy={state.busy}
        disabled={disabled}
        value={state.draft}
        onChange={pane.setDraft}
        focusToken={state.draftFocus}
        cost={state.cost}
        onOpenCost={() => pane.openSettings('cost')}
        onSend={pane.sendMessage}
        onStop={() => window.DSX.agent.abort()}
        onRefreshContext={pane.refreshContext}
      />

      <footer className="bg-background flex flex-wrap items-center gap-1 border-t px-2 py-1">
        <Button variant="ghost" size="xs" disabled={!state.journalCount || disabled} onClick={() => pane.undo('last')}>
          <UndoIcon />
          {t('footer.undo')}
        </Button>
        <Button variant="ghost" size="xs" disabled={!state.journalCount || disabled} onClick={() => pane.undo('all')}>
          <TrashIcon />
          {t('footer.undoAll')}
        </Button>
        <Button variant="ghost" size="xs" disabled={disabled} onClick={pane.resetChat}>
          <ResetIcon />
          {t('footer.reset')}
        </Button>
        <span className="text-muted-foreground ml-auto max-w-[45%] truncate text-[10px]">
          {state.journalCount
            ? t('footer.changes', { count: state.journalCount, label: state.journalLabel })
            : t('footer.noChanges')}
        </span>
      </footer>

      <HistoryDrawer
        t={t}
        locale={state.locale}
        open={state.historyOpen}
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        onOpenChange={pane.toggleHistory}
        onSelect={pane.loadSession}
        onDelete={pane.deleteSession}
        onNewChat={pane.newChat}
      />
    </div>
  );
}
