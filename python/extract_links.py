#!/usr/bin/env python3

import re
from urllib.parse import unquote

def extract_links_from_html(file_path):
    """Extract link names and URLs from HTML file and format as markdown list."""
    
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Find all anchor tags with href attributes
    # Look for aria-label and href in any order
    pattern = r'<a[^>]*(?:aria-label="([^"]*)"[^>]*href="([^"]*)"[^>]*|href="([^"]*)"[^>]*aria-label="([^"]*)"[^>]*)'
    raw_matches = re.findall(pattern, content)
    
    # Clean up matches since we have two capture groups for each field
    matches = []
    for match in raw_matches:
        if match[0] and match[1]:  # aria-label first, then href
            matches.append((match[0], match[1]))
        elif match[2] and match[3]:  # href first, then aria-label
            matches.append((match[3], match[2]))
    
    # Also try to find links in <p> tags between anchor tags
    p_pattern = r'<p>([^<]+)</p></div>.*?href="([^"]*)"'
    p_matches = re.findall(p_pattern, content, re.DOTALL)
    matches.extend(p_matches)
    
    links = []
    for name, url in matches:
        # Clean up URL - decode URL encoding and handle Google redirects
        if url.startswith('https://www.google.com/url?q='):
            # Extract the actual URL from Google redirect
            actual_url_match = re.search(r'q=([^&]*)', url)
            if actual_url_match:
                url = unquote(actual_url_match.group(1))
        
        # Skip relative URLs or internal links
        if not url.startswith('http'):
            continue
            
        links.append((name, url))
    
    # Remove duplicates while preserving order
    seen = set()
    unique_links = []
    for name, url in links:
        link_key = (name, url)
        if link_key not in seen:
            seen.add(link_key)
            unique_links.append((name, url))
    
    # Generate markdown
    markdown_lines = []
    for name, url in unique_links:
        markdown_lines.append(f"- {name}: {url}")
    
    return "\n".join(markdown_lines)

if __name__ == "__main__":
    html_file = "links.html"
    markdown_output = extract_links_from_html(html_file)
    print(markdown_output)
    
    # Also save to file
    with open("extracted_links.md", "w", encoding="utf-8") as f:
        f.write(markdown_output)
    
    print(f"\nMarkdown saved to extracted_links.md")