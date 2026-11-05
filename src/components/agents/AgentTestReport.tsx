/**
 * What "Test it" found, on the card it was started from (`card.test`).
 *
 * Who said what is kept apart: the outcome, summary and what's broken are the
 * agent's words; the console errors and the steps are what the app saw the
 * page and the agent do. The screenshots are the steps that kept one.
 *
 * @module components/agents/AgentTestReport
 */

import { useState } from 'react';
import { ChevronRightIcon, ErrorIcon, SuccessIcon, WarningIcon } from '@/components/icons';
import { TextButton } from '../primitives/TextButton';
import { AttachmentLightbox } from './AgentAttachments';
import { attachmentUrl, type Agent, type Attachment } from '../../lib/agents';
import {
  consoleLine,
  testShots,
  type TestReport,
} from '../../../packages/companion-protocol/src/results';

export function TestReportView({ agent, report }: { agent: Agent; report: TestReport }) {
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [stepsOpen, setStepsOpen] = useState(false);
  const broken = report.broken ?? [];
  const errors = report.consoleErrors ?? [];
  const steps = report.steps ?? [];
  const shots = testShots(report);
  const passed = report.outcome === 'passed';
  const consoleSummary = consoleLine(report);
  return (
    <section
      className="agent-test-report"
      data-outcome={report.outcome}
      aria-label="Tested in the preview"
    >
      <h4 className="agent-test-report__title">
        {/* Told apart by the icon and the words, not only the colour. */}
        {passed ? <SuccessIcon size={14} /> : <WarningIcon size={14} />}
        <span>{passed ? 'Tested in the preview: it works' : 'Tested in the preview: broken'}</span>
      </h4>
      {report.summary && <p className="agent-test-report__summary">{report.summary}</p>}
      {broken.length > 0 && (
        <ul className="agent-test-report__broken" aria-label="What's broken">
          {broken.map((line, i) => (
            <li key={`${i}:${line}`}>{line}</li>
          ))}
        </ul>
      )}
      {consoleSummary && (
        <div className="agent-test-report__console">
          <span className="agent-test-report__console-title">
            <ErrorIcon size={12} />
            {consoleSummary} on the page
          </span>
          <ul>
            {errors.map((line, i) => (
              <li key={`${i}:${line}`}>
                <code>{line}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {shots.length > 0 && (
        <div className="agent-test-report__shots" aria-label="Screenshots from the test">
          {shots.map(({ shot, label }) => (
            <button
              key={shot.path}
              type="button"
              className="agent-test-report__shot"
              onClick={() => setViewing(shot)}
              aria-label={`View screenshot: ${label}`}
              title={label}
            >
              <img src={attachmentUrl(agent.home, shot)} alt="" loading="lazy" />
              <span className="agent-test-report__shot-label">{label}</span>
            </button>
          ))}
        </div>
      )}
      {steps.length > 0 && (
        <>
          <TextButton
            tabIndex={0}
            className="agent-test-report__steps-toggle"
            aria-expanded={stepsOpen}
            leftIcon={<ChevronRightIcon size={12} />}
            onClick={() => setStepsOpen((v) => !v)}
          >
            {stepsOpen
              ? 'Hide what it did'
              : `What it did · ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`}
          </TextButton>
          {stepsOpen && (
            <ol className="agent-test-report__steps">
              {steps.map((step, i) => (
                <li key={`${step.ts}:${i}`} data-ok={step.ok || undefined}>
                  {step.ok ? <SuccessIcon size={12} /> : <ErrorIcon size={12} />}
                  <span>{step.label}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      <AttachmentLightbox agent={agent} viewing={viewing} onClose={() => setViewing(null)} />
    </section>
  );
}
