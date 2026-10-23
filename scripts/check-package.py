#!/usr/bin/env python3
"""Verifica apenas a integridade documental do pacote inicial, NÃO a aplicação."""
from pathlib import Path
import json, sys
p = Path(__file__).resolve().parent.parent
required = [
    'README.md','START_HERE.md','PROMPT_MESTRE_CLAUDE_CODE.md','CLAUDE.md','AGENTS.md',
    'docs/PRD.md','docs/ARQUITETURA.md','docs/BACKLOG.md','docs/SEGURANCA.md',
    'docs/DEPLOY.md','docs/UX_UI.md','docs/API_E_INTEGRACOES.md','docs/TESTES.md',
    'agent/memory/NOW.md','agent/memory/INDEX.md','help/README.md',
    'contracts/openapi.v1.stub.yaml','fixtures/billing_calendar_cases.json'
]
missing = [s for s in required if not (p/s).is_file() or (p/s).stat().st_size == 0]
if missing:
    print('Arquivos ausentes:', *missing, sep='\n - '); sys.exit(1)
with (p/'fixtures/billing_calendar_cases.json').open(encoding='utf8') as f:
    data = json.load(f)
assert len(data['cases']) >= 10
try:
    import yaml
    with (p/'contracts/openapi.v1.stub.yaml').open(encoding='utf8') as f:
        api = yaml.safe_load(f)
    assert api['openapi'] == '3.1.0'
    print('OpenAPI YAML: sintaxe parseável (não garante validade semântica).')
except ModuleNotFoundError:
    print('PyYAML ausente; validação YAML não executada.')
print(f'Pacote documental OK: {len(required)} arquivos obrigatórios; {len(data["cases"])} cenários de faturamento.')
