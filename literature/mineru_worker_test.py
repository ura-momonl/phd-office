"""No models: verify the MinerU content-list -> index boundary with synthetic data."""
import unittest
from mineru_worker import content_items


class ContentItemsTest(unittest.TestCase):
    def test_page_heading_and_inline_math(self):
        items = content_items([
            {'type': 'text', 'text_level': 1, 'page_idx': 3, 'text': 'Results'},
            {'type': 'text', 'page_idx': 3, 'text': 'The energy is $E$.'},
        ])
        self.assertEqual(items[0], {'p': 4, 'label': 'section_header', 'level': 1, 'text': 'Results'})
        self.assertEqual(items[1]['text'], 'The energy is $E$.')

    def test_equation_table_and_captions(self):
        items = content_items([
            {'type': 'equation', 'page_idx': 0, 'text': 'E=mc^2', 'text_format': 'latex'},
            {'type': 'table', 'page_idx': 1, 'table_caption': ['Table 1'],
             'table_body': '<table><tr><td>4 K</td></tr></table>', 'table_footnote': ['Measured value']},
            {'type': 'image', 'page_idx': 1, 'image_caption': ['Figure 1: fictional measurement'], 'img_path': 'unused.png'},
            {'type': 'code', 'page_idx': 2, 'code_body': 'print(1)'},
        ])
        self.assertEqual(items[0]['text'], '$$E=mc^2$$')
        self.assertEqual([x['label'] for x in items[1:4]], ['table'] * 3)
        self.assertIn('<table>', items[2]['text'])
        self.assertEqual(items[4]['label'], 'caption')
        self.assertEqual(items[5]['text'], 'print(1)')

    def test_references_and_auxiliary_text(self):
        items = content_items([
            {'type': 'header', 'page_idx': 0, 'text': 'Running header'},
            {'type': 'page_number', 'page_idx': 0, 'text': '1'},
            {'type': 'list', 'sub_type': 'ref_text', 'page_idx': 2, 'list_items': ['First reference', 'Second reference']},
            {'type': 'page_footnote', 'page_idx': 2, 'text': 'Corresponding author'},
        ])
        self.assertEqual([x['text'] for x in items], ['First reference', 'Second reference', 'Corresponding author'])
        self.assertTrue(all(x['p'] == 3 for x in items))


if __name__ == '__main__':
    unittest.main()
