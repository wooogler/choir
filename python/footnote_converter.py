#!/usr/bin/env python3
import re
import sys
import argparse
import os

def convert_footnotes_to_inline(input_file, output_file=None):
    """
    Convert footnotes from [^n] format to inline parenthetical format
    """
    
    if not os.path.exists(input_file):
        print(f"Error: Input file '{input_file}' not found!")
        return False
    
    # Read the file
    with open(input_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Dictionary to store footnote definitions
    footnotes = {}
    
    # Find all footnote definitions [^n]: content
    footnote_pattern = r'\n\[(\^(\d+))\]:\s*(.*?)(?=\n\[|\n$|\Z)'
    matches = re.findall(footnote_pattern, content, re.DOTALL)
    
    print(f"Found {len(matches)} footnote definitions")
    
    if not matches:
        print("No footnotes found in the file.")
        return True
    
    for match in matches:
        footnote_ref = match[0]  # ^n
        footnote_num = match[1]  # n
        footnote_content = match[2].strip()  # content
        footnotes[footnote_num] = footnote_content
        print(f"Footnote {footnote_num}: {footnote_content[:100]}...")
    
    # Replace footnote references [^n] with (content) in the main text
    for num, content_text in footnotes.items():
        # Find footnote reference pattern
        ref_pattern = rf'\[(\^{num})\]'
        replacement = f'({content_text})'
        
        # Replace in content
        content = re.sub(ref_pattern, replacement, content)
        print(f"Replaced [^{num}] with inline content")
    
    # Remove footnote definitions from the end
    # Remove all footnote definition lines
    footnote_def_pattern = r'\n\[(\^\d+)\]:\s*.*?(?=\n\[|\n$|\Z)'
    content = re.sub(footnote_def_pattern, '', content, flags=re.DOTALL)
    
    # Clean up multiple empty lines
    content = re.sub(r'\n{3,}', '\n\n', content)
    
    # Determine output file
    if output_file is None:
        output_file = input_file  # Overwrite original file
    
    # Write back to file
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print(f"Successfully converted footnotes to inline format in {output_file}")
    return True

def main():
    parser = argparse.ArgumentParser(
        description='Convert markdown footnotes from [^n] format to inline parenthetical format',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s document.md                    # Convert footnotes in document.md (overwrites original)
  %(prog)s document.md -o converted.md    # Convert and save to converted.md
  %(prog)s *.md                          # Convert footnotes in all .md files
        """
    )
    
    parser.add_argument('input_file', 
                        help='Input markdown file(s) to convert')
    
    parser.add_argument('-o', '--output', 
                        help='Output file (default: overwrite input file)')
    
    parser.add_argument('-v', '--verbose', 
                        action='store_true',
                        help='Show detailed output')
    
    args = parser.parse_args()
    
    if not args.verbose:
        # Reduce output when not in verbose mode
        import sys
        class QuietPrint:
            def write(self, x): pass
            def flush(self): pass
        #sys.stdout = QuietPrint()
    
    success = convert_footnotes_to_inline(args.input_file, args.output)
    
    if not success:
        sys.exit(1)

if __name__ == "__main__":
    main() 