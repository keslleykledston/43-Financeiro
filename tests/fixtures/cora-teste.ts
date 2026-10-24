// Fixtures DESCARTÁVEIS (CN "descartavel-so-para-teste"): certificado autoassinado e chaves geradas só para os testes.
// Nunca foram usados em nenhum serviço e não são credenciais da Cora. Arquivos .pem ficam fora do Git por regra (.gitignore), por isso vivem aqui como texto.
export const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBnjCCAUOgAwIBAgIUWqrE3fhP2gnB9M9SCCgMb134m+QwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZZGVzY2FydGF2ZWwtc28tcGFyYS10ZXN0ZTAeFw0yNjEwMjQx
NzIzMzNaFw0zNjEwMjExNzIzMzNaMCQxIjAgBgNVBAMMGWRlc2NhcnRhdmVsLXNv
LXBhcmEtdGVzdGUwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASoxfAfvUW5rqJp
+rsC5DUiv7KyrD/+jdbpcKHj3DRfDoX70bH+I7jp1EM2JWk8Q9WzLeLljqoSEQiG
5uR/DDPco1MwUTAdBgNVHQ4EFgQUcDIIgyXVHghM9GMYYvxAUQ1lK2IwHwYDVR0j
BBgwFoAUcDIIgyXVHghM9GMYYvxAUQ1lK2IwDwYDVR0TAQH/BAUwAwEB/zAKBggq
hkjOPQQDAgNJADBGAiEA6CqIhHsU2BBPxzgKSUPW1dkHofsmoCHrSOQdD2yG44IC
IQDhutaEP6kUeK4K89H3sNaU5GiX+PN4NdxZGMbeuCwH0g==
-----END CERTIFICATE-----
`;
export const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQglVgBGBLEKAIru1HN
9ABsUlbKyz9miuegtr1NFw0tKxuhRANCAASoxfAfvUW5rqJp+rsC5DUiv7KyrD/+
jdbpcKHj3DRfDoX70bH+I7jp1EM2JWk8Q9WzLeLljqoSEQiG5uR/DDPc
-----END PRIVATE KEY-----
`;
export const OTHER_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgAJictcsHIKS32tQs
hO3jq03W8tFgijat5N2nhHb5GuuhRANCAARhScjMy2GCROHopEKnUH0739rq/wM4
q5+3UPBp16sDOKAIMN6mi+ot4kQOOVpcSBo4Pe3S+7l+SFIgEmMAeTEF
-----END PRIVATE KEY-----
`; // NÃO combina com TEST_CERT
export const ENCRYPTED_KEY = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIHsMFcGCSqGSIb3DQEFDTBKMCkGCSqGSIb3DQEFDDAcBAh9+4O9VntADwICCAAw
DAYIKoZIhvcNAgkFADAdBglghkgBZQMEASoEEFUrsZ4ulOse2zgMVAsaFRwEgZCt
7XAJSGWeh2SBkmhFXGbtSplg+Np5WVr+u+i4RSXRM5SAKaiXKrFWBhH+bgG4clQK
yBq+w4xASEo5d2VDDLV/JQT/V7M8/hjcGmeqxICV+EbJrZQ4WmxRiQGDyZhMtpKG
YMWNd+zYld9l3QOorErZLLCe2T43PjGv2U+gBcwIwFgX3TX2oHzEnMTu4BZOKmg=
-----END ENCRYPTED PRIVATE KEY-----
`; // mesma chave, protegida por senha: deve ser recusada
