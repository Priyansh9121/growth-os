'use client';

/**
 * Reports the embedded form's height to the parent page.
 *
 * THE ONLY MESSAGE THIS IFRAME EVER SENDS, and it sends nothing else. There is
 * deliberately **no inbound message handler**: the iframe accepts no commands
 * from the host, so there is no message schema for a hostile parent to attack
 * (ADR-0027).
 *
 * WHY `targetOrigin: '*'` IS DEFENSIBLE HERE
 * We do not reliably know the parent's origin — the embed runs on arbitrary
 * customer domains, and requiring the origin up front would mean the customer
 * configuring it before the form could resize.
 *
 * What is disclosed by the message is a HEIGHT IN PIXELS and the public form
 * key the parent already supplied to create this frame. There is nothing in it
 * that any listener could not already observe. A message carrying anything
 * else — a submission result, a field value, an identifier — would not be
 * sent this way.
 *
 * The PARENT side does validate: the loader checks `event.source` is the frame
 * it created and that the key matches, so an unrelated frame cannot resize
 * someone's embed.
 */

import { useEffect } from 'react';

export function EmbedResizeReporter({ formKey }: { formKey: string }) {
  useEffect(() => {
    if (window.parent === window) return;

    const report = (): void => {
      const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
      window.parent.postMessage({ source: 'growth-os', type: 'resize', formKey, height }, '*');
    };

    report();

    // `ResizeObserver` rather than a poll: the height changes when a validation
    // error appears or the success message replaces the form, and both are
    // user-visible moments where a delayed resize looks broken.
    const observer = new ResizeObserver(report);
    observer.observe(document.documentElement);

    return () => observer.disconnect();
  }, [formKey]);

  return null;
}
