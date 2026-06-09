#!/usr/bin/env python3
# Извлечение ТЕКСТА из офисных форматов для агента procure-ai.
# Используется backend'ом (backend/extract-text.js) как подпроцесс — это безопаснее,
# чем Node-библиотека SheetJS (неустранённые в npm уязвимости на недоверенных файлах).
#
# Использование:  python3 doc_to_text.py <файл>
# Вывод:          текст документа на stdout
# Коды возврата:  0 — успех, 1 — ошибка/неподдерживаемый формат (детали на stderr)
import os
import sys


def xlsx_text(path):
    """Читаем .xlsx через openpyxl (data_only — значения, а не формулы)."""
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True, read_only=True)
    out = []
    for ws in wb.worksheets:
        out.append("# Лист: {}".format(ws.title))
        for row in ws.iter_rows(values_only=True):
            cells = [str(c) for c in row if c is not None and str(c).strip() != ""]
            if cells:
                out.append("\t".join(cells))
    return "\n".join(out)


def xls_text(path):
    """Читаем старый .xls через xlrd."""
    import xlrd
    wb = xlrd.open_workbook(path)
    out = []
    for sh in wb.sheets():
        out.append("# Лист: {}".format(sh.name))
        for r in range(sh.nrows):
            cells = [str(c.value) for c in sh.row(r) if str(c.value).strip() != ""]
            if cells:
                out.append("\t".join(cells))
    return "\n".join(out)


def docx_text(path):
    """Читаем .docx через python-docx: абзацы + ячейки таблиц."""
    import docx
    d = docx.Document(path)
    parts = [p.text for p in d.paragraphs if p.text.strip()]
    for table in d.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                parts.append("\t".join(cells))
    return "\n".join(parts)


def main():
    if len(sys.argv) != 2:
        print("usage: doc_to_text.py <file>", file=sys.stderr)
        return 1
    path = sys.argv[1]
    ext = os.path.splitext(path)[1].lower()
    handlers = {".xlsx": xlsx_text, ".xls": xls_text, ".docx": docx_text}
    handler = handlers.get(ext)
    if handler is None:
        print("unsupported extension: {}".format(ext), file=sys.stderr)
        return 1
    try:
        sys.stdout.write(handler(path))
        return 0
    except Exception as e:  # noqa: BLE001 — любой сбой парсинга → ошибка извлечения
        print("extract error: {}".format(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
