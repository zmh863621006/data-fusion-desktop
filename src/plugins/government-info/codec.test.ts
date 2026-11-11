import { describe, expect, it } from 'vitest';
import { decryptEcs14Request, decryptEcsRequest, encryptEcs14Request, encryptEcsRequest } from './codec';

describe('government information ECS codec', () => {
  it('round-trips a data-type 16 request', () => {
    const value = JSON.stringify(['包含中文和 % 通配符的参数']);
    expect(decryptEcsRequest(encryptEcsRequest(value))).toBe(value);
  });

  it('round-trips a data-type 14 request without zlib', () => {
    const value = '["workflow-测试",null,null,null]';
    expect(decryptEcs14Request(encryptEcs14Request(value))).toBe(value);
  });

  it('decrypts a captured data-type 16 request from the original project', () => {
    const captured = 'a=snVC0eJx9k9+K00AUxl9lCCxpoVsyaatVmoXdoldVlAVvNkuZJifJ1EkmnZmUbaWP4JXs5SJeeCve+z7Vx3D+tLZ1xUBgznd+Z+aczJcb70Ps1USQEhQIGXvPb7RQ6VAvY0/O5Dz2OrG3JKxxUhiEg/MAn+OBTWSM5FrHTza3OoI7BVX6tgGxQyiqPBsjDCEUaIVClqtVpyJadEAKHpReT3+0EvGARHj2+5AzTaQ8+OHge1pIJarWqIAsTFUYjdHjo0I0T+zx+ftg+f/XYbtfdtyNlSD0p5hahEFVeoahizOTXPJKIVavmB3/GxfkP99ky1PkTSvCKqEVAXXPGTYp3NBC9d25GPA7yr0YetVTS0uyc6q7gYXfhhgJ/++vJ1e/99+/GbG4hBlatC40wW7VEv0OVuTiMgRt8D8s/GeGi+UxgOcIhDveqd+bYzA01lwYX6H9q298VFCuLP3aIUZGJ1vXhJgaV7C2QmcNxClI6ZQU4rc9l6Lena+AFvOn/D63lRnuD9IzywNqlJDq942jBnKUjkdGE8c8mYrTTp2c51025O8pE165+2DkyJyOknMLdVM5sUQ5qzFN4t3OqEg1oNdGSscYja1NZ1iq3lYY57FjWsWenOvwFbK0eg0Z1winNFpn8x7ZOtuNTmVPTT0aYND3OyZKMGZHS0gkvu4xXuaASupMXl2+6V5NJd0ySArrXQERSXDWU2VvceLe/AT4rNgE=b8f3l';
    const parameters = JSON.parse(decryptEcsRequest(captured)) as string[];
    const query = JSON.parse(parameters[0]) as Record<string, unknown>;

    expect(parameters).toHaveLength(1);
    expect(query.name).toBe('laam_ex_sb');
    expect(query.pageModule).toBe('ecs_queryAll');
    expect(query.parameters).toEqual([{ name: 'sbsj', value: '2025-01-15', flag: 16 }]);
  });
});
