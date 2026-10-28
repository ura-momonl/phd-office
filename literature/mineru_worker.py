"""GPU MinerU batch entry: jobs.json = [{id, file, out}]. No parser fallback.

Outputs [{p,label,level,text}] using 1-based original PDF pages for the index.
Reuses the same GPU guards as the manual markdown entry; parses jobs serially.
"""
import json
from pathlib import Path
import sys
import time

from mineru_gpu import configure_gpu


def content_items(content):
    """Adapt MinerU's public Content List V1 without losing equations/captions."""
    items = []
    for block in content:
        kind = block['type']
        page = int(block['page_idx']) + 1
        level = block.get('text_level')
        label = 'section_header' if kind == 'text' and level is not None else kind
        if kind in ('header', 'footer', 'page_number', 'page_header', 'page_footer'):
            continue
        if kind in ('list', 'index'):
            texts = block.get('list_items', [])
        elif kind in ('table', 'image', 'chart', 'code'):
            texts = [*block.get(kind + '_caption', []),
                     block.get(kind + '_body', block.get('content', '')),
                     *block.get(kind + '_footnote', [])]
            # Index image captions as text, not as a picture (which chunking skips).
            if kind == 'image':
                label = 'caption'
        else:
            texts = [block.get('text', '')]
        for text in texts:
            if text and text.strip():
                if kind == 'equation' and block.get('text_format') == 'latex':
                    text = '$$' + text + '$$'
                items.append({'p': page, 'label': label, 'level': level, 'text': text})
    return items


def main():
    jobs = json.loads(Path(sys.argv[1]).read_text(encoding='utf8'))
    print(json.dumps(configure_gpu()), file=sys.stderr, flush=True)
    from mineru.parser import parse
    from mineru.render import render_content_list
    from mineru.model.vlm.runtime import shutdown_cached_models
    try:
        for job in jobs:
            started = time.monotonic()
            try:
                result = parse(Path(job['file']), tier='standard')
                items = content_items(render_content_list(result.middle_json))
                if not items:
                    raise ValueError('MinerU produced no text items')
                Path(job['out']).write_text(json.dumps(items, ensure_ascii=False), encoding='utf8')
                print(json.dumps({'id': job['id'], 'ok': True, 'items': len(items),
                                  'sec': round(time.monotonic() - started, 1)}), flush=True)
            except Exception as error:
                print(json.dumps({'id': job['id'], 'ok': False, 'error': str(error)[:200]},
                                 ensure_ascii=False), flush=True)
    finally:
        shutdown_cached_models()


if __name__ == '__main__':
    main()
