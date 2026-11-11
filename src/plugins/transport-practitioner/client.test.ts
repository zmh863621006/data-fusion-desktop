import { describe, expect, it } from 'vitest';
import { parseGatewayResponse } from './client';

describe('practitioner gateway response parser', () => {
  it('unwraps the legacy data.string envelope', () => {
    const inner = JSON.stringify({ publicresponse: { statuscode: 0 }, body: { totalcount: 1, items: [{ Id: '1' }] } });
    const raw = JSON.stringify({ data: { string: JSON.stringify(inner) } });
    expect(parseGatewayResponse(raw)).toEqual({
      publicresponse: { statuscode: 0 },
      body: { totalcount: 1, items: [{ Id: '1' }] },
    });
  });
});
