import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Header } from '../../src/gui/src/components/Header';
import { StatusBar } from '../../src/gui/src/components/StatusBar';
import { ThemeProvider } from '../../src/gui/src/components/ThemeContext';

describe('GUI readiness status', () => {
  it('renders reported API/session context and labels unreported subsystems honestly', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(Header, {
          projectRoot: 'C:\\demo\\industrial',
          apiStatus: 'HEALTHY',
          sessionStatus: 'NO TOKEN',
        }),
      ),
    );

    expect(html).toContain('C:\\demo\\industrial');
    expect(html).toContain('API: HEALTHY');
    expect(html).toContain('SESSION TOKEN: NO TOKEN');
    expect(html).toContain('MODEL: NOT REPORTED');
    expect(html).toContain('ENGINE: NOT REPORTED');
    expect(html).not.toContain('LOCAL API // EGRESS UNVERIFIED');
    expect(html).not.toContain('SHA-256 VERIFIED');
  });

  it('does not show an unverified project root or fixed host when the API is unavailable', () => {
    const html = renderToStaticMarkup(
      React.createElement(StatusBar, {
        projectRoot: 'UNVERIFIED',
        apiEndpoint: '127.0.0.1:3847',
        apiStatus: 'UNAVAILABLE',
      }),
    );

    expect(html).toContain('PROJECT:</strong> UNVERIFIED');
    expect(html).toContain('API:</strong> UNAVAILABLE');
    expect(html).toContain('STAGE:</strong> NO ACTIVE RUN REPORTED');
    expect(html).toContain('API TARGET:</strong> 127.0.0.1:3847');
    expect(html).not.toContain('RUST:');
  });
});
