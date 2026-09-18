<!--lit-part J1rEYwaybRw=-->

<!--lit-node 0-->

## <!--lit-node 1-->[Try it](#try_it)

<!--/lit-part-->

```
<table>
  <caption>
    Front-end web developer course 2021
  </caption>
  <thead>
    <tr>
      <th scope="col">Person</th>
      <th scope="col">Most interest in</th>
      <th scope="col">Age</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row">Chris</th>
      <td>HTML tables</td>
      <td>22</td>
    </tr>
    <tr>
      <th scope="row">Dennis</th>
      <td>Web accessibility</td>
      <td>45</td>
    </tr>
    <tr>
      <th scope="row">Sarah</th>
      <td>JavaScript frameworks</td>
      <td>29</td>
    </tr>
    <tr>
      <th scope="row">Karen</th>
      <td>Web performance</td>
      <td>36</td>
    </tr>
  </tbody>
  <tfoot>
    <tr>
      <th scope="row" colspan="2">Average age</th>
      <td>33</td>
    </tr>
  </tfoot>
</table>
```

```
table {
  border-collapse: collapse;
  border: 2px solid rgb(140 140 140);
  font-family: sans-serif;
  font-size: 0.8rem;
  letter-spacing: 1px;
}

caption {
  caption-side: bottom;
  padding: 10px;
  font-weight: bold;
}

thead,
tfoot {
  background-color: rgb(228 240 245);
}

th,
td {
  border: 1px solid rgb(160 160 160);
  padding: 8px 10px;
}

td:last-of-type {
  text-align: center;
}

tbody > tr:nth-of-type(even) {
  background-color: rgb(237 238 242);
}

tfoot th {
  text-align: right;
}

tfoot td {
  font-weight: bold;
}
```

<!--lit-part L9WEzIPeMGU=-->

<!--lit-node 0-->

## <!--lit-node 1-->[Attributes](#attributes)

<!--/lit-part-->

This element includes the [global attributes](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes).

<!--lit-part DtWy1dPw+nY=-->

<!--lit-node 0-->

### <!--lit-node 1-->[Deprecated attributes](#deprecated_attributes)

<!--/lit-part-->

The following attributes are deprecated and should not be used. They are documented below for reference when updating existing code and for historical interest only.

- [`align`](#align)

  Specifies the horizontal alignment of the table within its parent element. The possible [enumerated](https://developer.mozilla.org/en-US/docs/Glossary/Enumerated) values are `left`, `center`, and `right`. Use the [`margin-inline-start`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/margin-inline-start) and [`margin-inline-end`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/margin-inline-end) CSS properties instead, as this attribute is deprecated.

- [`bgcolor`](#bgcolor)

  Defines the background color of the table. The value is an HTML color; either a [6-digit hexadecimal RGB code](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/hex-color), prefixed by a `#`, or a [color keyword](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/named-color). Other CSS [`<color>`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/color_value) values are not supported. Use the [`background-color`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/background-color) CSS property instead, as this attribute is deprecated.

- [`border`](#border)

  Defines, as a non-negative integer value (in pixels), the size of the frame surrounding the table. If set to `0`, the [`frame`](#frame) attribute is set to void. Use the [`border`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/border) CSS property instead, as this attribute is deprecated.

- [`cellpadding`](#cellpadding)

  Defines the space between the content of a cell and its border. This attribute is obsolete: instead of using it, apply the [`padding`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/padding) CSS property to the [`<th>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th) and [`<td>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/td) elements.

- [`cellspacing`](#cellspacing)

  Defines the size of the space between two cells. This attribute is obsolete: instead of using it, set the [`border-spacing`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/border-spacing) CSS property on the `<table>` element. Note that this has no effect if the `<table>` element's [`border-collapse`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/border-collapse) CSS property is set to `collapse`.

- [`frame`](#frame)

  Defines which side of the frame surrounding the table must be displayed. The possible [enumerated](https://developer.mozilla.org/en-US/docs/Glossary/Enumerated) values are `void`, `above`, `below`, `hsides`, `vsides`, `lhs`, `rhs`, `box` and `border`. Use the [`border-style`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/border-style) and [`border-width`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/border-width) CSS properties instead, as this attribute is deprecated.

- [`rules`](#rules)

  Defines where rules (borders) are displayed in the table. The possible [enumerated](https://developer.mozilla.org/en-US/docs/Glossary/Enumerated) values are `none` (default value), `groups` ([`<thead>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/thead), [`<tbody>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tbody), and [`<tfoot>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tfoot) elements), `rows` (horizontal lines), `cols` (vertical lines), and `all` (border around every cell). Use the [`border`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/border) CSS property on the appropriate table-related elements, as well as on the `<table>` itself, instead, as this attribute is deprecated.

- [`summary`](#summary)

  Defines an alternative text that summarizes the content of the table. Use the [`<caption>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/caption) element instead, as this attribute is deprecated.

- [`width`](#width)

  Specifies the width of the table. Use the [`width`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/width) CSS property instead, as this attribute is deprecated.

  **Note:** While no HTML specification includes `height` as a `<table>` attribute, some browsers support a non-standard interpretation of `height`. The unitless value sets a minimum absolute height in pixels. If set as a percent value, the minimum table height will be relative to the parent container's height. Use the [`min-height`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/min-height) CSS property instead, as this attribute is deprecated.

<!--lit-part wqO7XCIaguU=-->

<!--lit-node 0-->

## <!--lit-node 1-->[Visual layout of table contents](#visual_layout_of_table_contents)

<!--/lit-part-->

Following elements are part of the table structure:

- [`<caption>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/caption)
- [`<thead>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/thead)
- [`<colgroup>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/colgroup)
- [`<col>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/col)
- [`<th>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th)
- [`<tbody>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tbody)
- [`<tr>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tr)
- [`<td>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/td)
- [`<tfoot>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tfoot)

The `<table>` box establishes a table formatting context. Elements inside the `<table>` generate rectangular boxes. Each box occupies a number of table cells according to the following rules:

1. The row boxes fill the table in the source code order from top to bottom. Each row box occupies one row of cells.
2. A row group box occupies one or more row boxes.
3. Column boxes are placed next to each other in source code order. Depending on the value of the [`dir`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/dir) attribute, the columns are laid in left-to-right or right-to-left direction. A column box occupies one or more columns of table cells.
4. A column group box occupies one or more column boxes.
5. A cell box may span over multiple rows and columns. User agents trim cells to fit in the available number of rows and columns.

Table cells do have padding. Boxes that make up a table do not have margins.

<!--lit-part az/LOMXagys=-->

<!--lit-node 0-->

### <!--lit-node 1-->[Table layers and transparency](#table_layers_and_transparency)

<!--/lit-part-->

For styling purpose the table elements may be thought of as being put on six superimposed layers:

![Table element layers](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/table/table_element_layers.png)

The background set on an element in one layer will be visible only if the layers above it have transparent background. A missing cell is rendered as if an anonymous table-cell box occupied that place.

<!--lit-part uX03txTmwno=-->

<!--lit-node 0-->

## <!--lit-node 1-->[Accessibility](#accessibility)

<!--/lit-part-->

<!--?-->

<!--lit-part 1hY4d2g2QG4=-->

<!--lit-node 0-->

### <!--lit-node 1-->[Captions](#captions)

<!--/lit-part-->

By supplying a [`<caption>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/caption) element whose value clearly and concisely describes the table's purpose, it helps the people decide if they need to check the rest of the table content or skip over it.

This helps people navigating with the aid of assistive technology such as a screen reader, people experiencing low vision conditions, and people with cognitive concerns.

- [MDN Adding a caption to your table with \<caption>](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content/Table_accessibility#adding_a_caption_to_your_table_with_caption)
- [Caption & Summary • Tables • W3C WAI Web Accessibility Tutorials](https://www.w3.org/WAI/tutorials/tables/caption-summary/ "External link (opens in new tab)")

<!--lit-part D2ba2BTHaN4=-->

<!--lit-node 0-->

### <!--lit-node 1-->[Scoping rows and columns](#scoping_rows_and_columns)

<!--/lit-part-->

The [`scope`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th#scope) attribute on header cells ([`<th>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th) elements) is redundant in simple contexts, because scope is inferred. However, some assistive technologies may fail to draw correct inferences, so specifying header scope may improve user experiences. In complex tables, [`scope`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th#scope) can be specified to provide necessary information about the cells related to a header.

- [MDN table accessibility guide](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content/Table_accessibility)
- [Tables with two headers • Tables • W3C WAI Web Accessibility Tutorials](https://www.w3.org/WAI/tutorials/tables/two-headers/ "External link (opens in new tab)")
- [Tables with irregular headers • Tables • W3C WAI Web Accessibility Tutorials](https://www.w3.org/WAI/tutorials/tables/irregular/ "External link (opens in new tab)")
- [H63: Using the scope attribute to associate header cells and data cells in data tables | W3C Techniques for WCAG 2.0](https://www.w3.org/TR/WCAG20-TECHS/H63.html "External link (opens in new tab)")

<!--lit-part QFA1VG1WCZA=-->

<!--lit-node 0-->

### <!--lit-node 1-->[Complicated tables](#complicated_tables)

<!--/lit-part-->

Assistive technologies such as screen readers may have difficulty parsing tables that are so complex that header cells can't be associated in a strictly horizontal or vertical way. This is typically indicated by the presence of the [`colspan`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/td#colspan) and [`rowspan`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/td#rowspan) attributes.

Ideally, consider alternate ways to present the table's content, including breaking it apart into a collection of smaller, related tables that don't have to rely on using the [`colspan`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/td#colspan) and [`rowspan`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/td#rowspan) attributes. In addition to helping people who use assistive technology understand the table's content, this may also benefit people with cognitive concerns who may have difficulty understanding the associations the table layout is describing.

If the table cannot be broken apart, use a combination of the [`id`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/id) and [`headers`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/td#headers) attributes to programmatically associate each table cell with the header(s) ([`<th>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th) elements) the cell is associated with.

- [MDN table accessibility guide](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content/Table_accessibility)
- [Tables with multi-level headers • Tables • W3C WAI Web Accessibility Tutorials](https://www.w3.org/WAI/tutorials/tables/multi-level/ "External link (opens in new tab)")
- [H43: Using id and headers attributes to associate data cells with header cells in data tables | Techniques for W3C WCAG 2.0](https://www.w3.org/TR/WCAG20-TECHS/H43.html "External link (opens in new tab)")

<!--lit-part cjTOnCoGGWc=-->

<!--lit-node 0-->

## <!--lit-node 1-->[Examples](#examples)

<!--/lit-part-->

The examples below include tables of progressively increasing complexity. See also our beginner's [Styling tables](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Styling_basics/Tables) guide for table styling information including common, useful techniques.

Since the structure of a `<table>` involves the use of several table-related HTML elements along with various associated attributes, the following examples are intended to provide a simplified explanation that covers the basics and common standards. Additional and more detailed information can be found on the corresponding linked pages.

These table examples demonstrate how to create an [accessible](https://developer.mozilla.org/en-US/docs/Glossary/Accessibility) table that is structured with HTML and styled with [CSS](https://developer.mozilla.org/en-US/docs/Web/CSS).

Because of how HTML tables are structured, the [markup](https://developer.mozilla.org/en-US/docs/Glossary/Markup) can quickly grow. For this reason, it is important to clearly define the table's purpose and final appearance to create the appropriate structure. A logical structure developed with [semantic](https://developer.mozilla.org/en-US/docs/Glossary/Semantics) markup is not only easier to style, but enables useful and accessible tables that can be understood and navigated by everyone, including search engines and users of assistive technologies.

The first example is basic, with subsequent examples growing in complexity. First, we will develop a very basic HTML table structure for the table. The first two examples contain no table section groups such as a defined head, body, or foot, and involve no cell spanning or explicitly defined cell relationships. Not even a caption is provided. As we work through the examples, they will be progressively enhanced to include all the table features that a complex data table should possess.

<!--lit-part WYVVcr4k9zM=-->

<!--lit-node 0-->

### <!--lit-node 1-->[Basic table](#basic_table)

<!--/lit-part-->

This example includes a *very* basic table with three rows and two columns. To demonstrate default browser table styles, no CSS has been included in this example.

#### HTML

The table rows are defined with [`<tr>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tr) elements, and the columns are defined with table header and data cells within them. The first row contains the header cells ([`<th>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th) elements) that serve as column headers for the data cells ([`<td>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/td) elements). Each element ([`<th>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th) or [`<td>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/td)) per row is in its respective column—that is, the first element of a row is in the first column, and the second element of that row is in the second column.

html

```
<table>
  <tr>
    <th>Name</th>
    <th>Age</th>
  </tr>
  <tr>
    <td>Maria Sanchez</td>
    <td>28</td>
  </tr>
  <tr>
    <td>Michael Johnson</td>
    <td>34</td>
  </tr>
</table>
```

#### Result

There is no custom [CSS](https://developer.mozilla.org/en-US/docs/Web/CSS) or [user stylesheet](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Cascade/Introduction#author_stylesheets) applied to this table. The styling results purely from the [user-agent stylesheet](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Cascade/Introduction#user-agent_stylesheets).

<!--lit-part NcvwLGeS0U8=-->

<!--lit-node 0-->

### <!--lit-node 1-->[Expanded table with header cells](#expanded_table_with_header_cells)

<!--/lit-part-->

This example extends the [basic table](#basic_table), extending the content and adding basic CSS styles.

#### HTML

The table comprises four rows ([`<tr>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tr) elements) now, with four columns each. The first row is a row of header cells (The first row contains only [`<th>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th) elements). Subsequent rows include a header column ([`<th>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th) elements as the first child elements of each row) and three data columns ([`<td>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/td) elements). As table sectioning elements are not used, the browser automatically defines the content group structure, i.e., all rows are wrapped within the body of the table of an implicit [`<tbody>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tbody) element.

html

```
<table>
  <tr>
    <th>Name</th>
    <th>ID</th>
    <th>Member Since</th>
    <th>Balance</th>
  </tr>
  <tr>
    <th>Margaret Nguyen</th>
    <td>427311</td>
    <td><time datetime="2010-06-03">June 3, 2010</time></td>
    <td>0.00</td>
  </tr>
  <tr>
    <th>Edvard Galinski</th>
    <td>533175</td>
    <td><time datetime="2011-01-13">January 13, 2011</time></td>
    <td>37.00</td>
  </tr>
  <tr>
    <th>Hoshi Nakamura</th>
    <td>601942</td>
    <td><time datetime="2012-07-23">July 23, 2012</time></td>
    <td>15.00</td>
  </tr>
</table>
```

#### CSS

With CSS, we provide the basic styling to create lines around the components of the table to make the data structure clearer. The CSS adds a solid border around the `<table>` and around each of the table's cells, including those specified with both [`<th>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th) and [`<td>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/td) elements, demarcating every header and data cells.

css

```
table {
  border: 2px solid rgb(140 140 140);
}

th,
td {
  border: 1px solid rgb(160 160 160);
}
```

#### Result

<!--lit-part 4tRBK/91Mdw=-->

<!--lit-node 0-->

### <!--lit-node 1-->[Specifying table cell relations](#specifying_table_cell_relations)

<!--/lit-part-->

Before moving on to extend the table in more advanced ways, it's advisable to improve [accessibility](https://developer.mozilla.org/en-US/docs/Glossary/Accessibility) by defining relationships between the header and data cells ([`<th>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th) and [`<td>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/td) elements).

#### HTML

This is accomplished by introducing the [`scope`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th#scope) attribute on the [`<th>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th) elements and setting the values to the corresponding `col` (column) or `row` value.

html

```
<table>
  <tr>
    <th scope="col">Name</th>
    <th scope="col">ID</th>
    <th scope="col">Member Since</th>
    <th scope="col">Balance</th>
  </tr>
  <tr>
    <th scope="row">Margaret Nguyen</th>
    <td>427311</td>
    <td><time datetime="2010-06-03">June 3, 2010</time></td>
    <td>0.00</td>
  </tr>
  <tr>
    <th scope="row">Edvard Galinski</th>
    <td>533175</td>
    <td><time datetime="2011-01-13">January 13, 2011</time></td>
    <td>37.00</td>
  </tr>
  <tr>
    <th scope="row">Hoshi Nakamura</th>
    <td>601942</td>
    <td><time datetime="2012-07-23">July 23, 2012</time></td>
    <td>15.00</td>
  </tr>
</table>
```

The CSS and visual result are unchanged—the adaptation provides valuable contextual information for assistive technologies such as screen readers to help identify which cells the headers relate to.

**Note:** If the table structure is even more complex, the (additional) use of the [`headers`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th#headers) attribute on the [`<th>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th) and [`<td>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/td) elements may improve accessibility and help assistive technologies identify the relationships between cells; see [Complicated tables](#complicated_tables).

<!--lit-part XBGsCVQlDe8=-->

<!--lit-node 0-->

### <!--lit-node 1-->[Explicitly specifying table section groups](#explicitly_specifying_table_section_groups)

<!--/lit-part-->

In addition to improving accessibility by [specifying cell relations](#specifying_table_cell_relations), the [semantics](https://developer.mozilla.org/en-US/docs/Glossary/Semantics) of the table can be improved by introducing table section groups.

#### HTML

Since the first row ([`<tr>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tr) element) contains only column header cells and provides the header for the rest of the table's contents, it can be enclosed in the [`<thead>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/thead) element to explicitly specify that row as the head section of the table. Moreover, what is automatically accomplished by the browser can also be defined explicitly—the body section of the table, which contains the main data of the table, is specified by enclosing the corresponding rows in the [`<tbody>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tbody) element. The explicit use of the [`<tbody>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tbody) element helps the browser to create the intended table structure, avoiding unwanted results.

html

```
<table>
  <thead>
    <tr>
      <th scope="col">Name</th>
      <th scope="col">ID</th>
      <th scope="col">Member Since</th>
      <th scope="col">Balance</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row">Margaret Nguyen</th>
      <td>427311</td>
      <td><time datetime="2010-06-03">June 3, 2010</time></td>
      <td>0.00</td>
    </tr>
    <tr>
      <th scope="row">Edvard Galinski</th>
      <td>533175</td>
      <td><time datetime="2011-01-13">January 13, 2011</time></td>
      <td>37.00</td>
    </tr>
    <tr>
      <th scope="row">Hoshi Nakamura</th>
      <td>601942</td>
      <td><time datetime="2012-07-23">July 23, 2012</time></td>
      <td>15.00</td>
    </tr>
  </tbody>
</table>
```

Once again, the CSS and visual result are unchanged—specifying such table section groups provides valuable contextual information for assistive technologies, including screen readers and search engines, as well as for styling in the CSS, which will be shown in a later example.

<!--lit-part K+agun1kN4c=-->

<!--lit-node 0-->

### <!--lit-node 1-->[Column and row spanning](#column_and_row_spanning)

<!--/lit-part-->

In this example, we extend the table even more by adding a column and introducing a multi-row head section.

#### HTML

Building on the table created so far, a new column for a "Membership End Date" is added in each body row with the [`<td>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/td) element. An additional row ([`<tr>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tr) element) is also added within the head section ([`<thead>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/thead) element) to introduce a "Membership Dates" header as a heading for the "Joined" and "Canceled" columns.

The creation of the second header row involves adding [`colspan`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th#colspan) and [`rowspan`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th#rowspan) attributes to the [`<th>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th) elements to allocate the header cells to the correct columns and rows.

html

```
<table>
  <thead>
    <tr>
      <th scope="col" rowspan="2">Name</th>
      <th scope="col" rowspan="2">ID</th>
      <th scope="col" colspan="2">Membership Dates</th>
      <th scope="col" rowspan="2">Balance</th>
    </tr>
    <tr>
      <th scope="col">Joined</th>
      <th scope="col">Canceled</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row">Margaret Nguyen</th>
      <td>427311</td>
      <td><time datetime="2010-06-03">June 3, 2010</time></td>
      <td>n/a</td>
      <td>0.00</td>
    </tr>
    <tr>
      <th scope="row">Edvard Galinski</th>
      <td>533175</td>
      <td><time datetime="2011-01-13">January 13, 2011</time></td>
      <td><time datetime="2017-04-08">April 8, 2017</time></td>
      <td>37.00</td>
    </tr>
    <tr>
      <th scope="row">Hoshi Nakamura</th>
      <td>601942</td>
      <td><time datetime="2012-07-23">July 23, 2012</time></td>
      <td>n/a</td>
      <td>15.00</td>
    </tr>
  </tbody>
</table>
```

```
table {
  border: 2px solid rgb(140 140 140);
}

th,
td {
  border: 1px solid rgb(160 160 160);
}
```

#### Result

The head section now has two rows, one with the headers ([`<th>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th) elements) "Name", "ID", "Membership Dates", and "Balance", and a "Membership Dates" header with two subheaders that are in a second row: "Joined" and "Canceled". This is accomplished by:

- The first row's "Name", "ID", and "Balance" header cells span both table header rows by using the [`rowspan`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th#rowspan) attribute, making them each two rows tall.
- The first row's "Membership Dates" header cell spans two columns using the [`colspan`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th#colspan) attribute, causing it to be two columns wide.
- The second row contains only the two header cells "Joined" and "Canceled" because the other three columns are merged with the cells in the first row that span two rows. The two header cells are correctly positioned under the "Membership Dates" header.

<!--lit-part yL6ZHKoEqJk=-->

<!--lit-node 0-->

### <!--lit-node 1-->[Table caption and column summary](#table_caption_and_column_summary)

<!--/lit-part-->

It's a common and advisable practice to provide a summary for the table's content, allowing users to quickly determine the table's relevance. Furthermore, the "Balance" column is summarized by displaying the sum of the balances of the individual members.

#### HTML

A table summary is added by using a table [caption](#captions) ([`<caption>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/caption) element) as the first child element of the `<table>`. The caption provides the [accessible name](https://developer.mozilla.org/en-US/docs/Glossary/Accessible_name) or [accessible description](https://developer.mozilla.org/en-US/docs/Glossary/Accessible_description) for the table.

Lastly, a table foot section ([`<tfoot>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tfoot) element) is added below the body, with a row that summarizes the "Balance" column by displaying a sum. The elements and attributes introduced earlier are applied.

html

```
<table>
  <caption>
    Status of the club members 2021
  </caption>
  <thead>
    <tr>
      <th scope="col" rowspan="2">Name</th>
      <th scope="col" rowspan="2">ID</th>
      <th scope="col" colspan="2">Membership Dates</th>
      <th scope="col" rowspan="2">Balance</th>
    </tr>
    <tr>
      <th scope="col">Joined</th>
      <th scope="col">Canceled</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row">Margaret Nguyen</th>
      <td>427311</td>
      <td><time datetime="2010-06-03">June 3, 2010</time></td>
      <td>n/a</td>
      <td>0.00</td>
    </tr>
    <tr>
      <th scope="row">Edvard Galinski</th>
      <td>533175</td>
      <td><time datetime="2011-01-13">January 13, 2011</time></td>
      <td><time datetime="2017-04-08">April 8, 2017</time></td>
      <td>37.00</td>
    </tr>
    <tr>
      <th scope="row">Hoshi Nakamura</th>
      <td>601942</td>
      <td><time datetime="2012-07-23">July 23, 2012</time></td>
      <td>n/a</td>
      <td>15.00</td>
    </tr>
  </tbody>
  <tfoot>
    <tr>
      <th scope="row" colspan="4">Total balance</th>
      <td>52.00</td>
    </tr>
  </tfoot>
</table>
```

```
table {
  border: 2px solid rgb(140 140 140);
}

th,
td {
  border: 1px solid rgb(160 160 160);
}
```

#### Result

<!--lit-part 3X/gKSgQ3LM=-->

<!--lit-node 0-->

### <!--lit-node 1-->[Basic table styling](#basic_table_styling)

<!--/lit-part-->

Let's apply a basic style to the table to adjust the typeface and add a [`background-color`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/background-color) to the head and foot rows. The HTML is unchanged this time, so let's dive right into the CSS.

```
<table>
  <caption>
    Status of the club members 2021
  </caption>
  <thead>
    <tr>
      <th scope="col" rowspan="2">Name</th>
      <th scope="col" rowspan="2">ID</th>
      <th scope="col" colspan="2">Membership Dates</th>
      <th scope="col" rowspan="2">Balance</th>
    </tr>
    <tr>
      <th scope="col">Joined</th>
      <th scope="col">Canceled</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row">Margaret Nguyen</th>
      <td>427311</td>
      <td><time datetime="2010-06-03">June 3, 2010</time></td>
      <td>n/a</td>
      <td>0.00</td>
    </tr>
    <tr>
      <th scope="row">Edvard Galinski</th>
      <td>533175</td>
      <td><time datetime="2011-01-13">January 13, 2011</time></td>
      <td><time datetime="2017-04-08">April 8, 2017</time></td>
      <td>37.00</td>
    </tr>
    <tr>
      <th scope="row">Hoshi Nakamura</th>
      <td>601942</td>
      <td><time datetime="2012-07-23">July 23, 2012</time></td>
      <td>n/a</td>
      <td>15.00</td>
    </tr>
  </tbody>
  <tfoot>
    <tr>
      <th scope="row" colspan="4">Total balance</th>
      <td>52.00</td>
    </tr>
  </tfoot>
</table>
```

#### CSS

While a [`font`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font) property is added to the `<table>` element here to set a more visually appealing typeface (or an abominable sans-serif typeface, depending on your personal opinion), the interesting part is the second style, where the [`<tr>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tr) elements located within the [`<thead>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/thead) and [`<tfoot>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tfoot) are styled adding a light blue [`background-color`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/background-color). This is a way to quickly apply a background color to all the cells in specific sections simultaneously.

css

```
table {
  border: 2px solid rgb(140 140 140);
  font:
    16px "Open Sans",
    "Helvetica",
    "Arial",
    sans-serif;
}

thead > tr,
tfoot > tr {
  background-color: rgb(228 240 245);
}

th,
td {
  border: 1px solid rgb(160 160 160);
}
```

#### Result

<!--lit-part ZVtYXHRiWlM=-->

<!--lit-node 0-->

### <!--lit-node 1-->[Advanced table styling](#advanced_table_styling)

<!--/lit-part-->

Now we'll go all-out, with styles on rows in the header and body areas both, including alternating row colors, cells with different colors depending on position within a row, and so forth. Let's take a look at the result first this time.

#### Result

Here's what the final table will look like:

There is no change to the HTML again. See what proper preparation of the HTML structure can do?

```
<table>
  <caption>
    Status of the club members 2021
  </caption>
  <thead>
    <tr>
      <th scope="col" rowspan="2">Name</th>
      <th scope="col" rowspan="2">ID</th>
      <th scope="col" colspan="2">Membership Dates</th>
      <th scope="col" rowspan="2">Balance</th>
    </tr>
    <tr>
      <th scope="col">Joined</th>
      <th scope="col">Canceled</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row">Margaret Nguyen</th>
      <td>427311</td>
      <td><time datetime="2010-06-03">June 3, 2010</time></td>
      <td>n/a</td>
      <td>0.00</td>
    </tr>
    <tr>
      <th scope="row">Edvard Galinski</th>
      <td>533175</td>
      <td><time datetime="2011-01-13">January 13, 2011</time></td>
      <td><time datetime="2017-04-08">April 8, 2017</time></td>
      <td>37.00</td>
    </tr>
    <tr>
      <th scope="row">Hoshi Nakamura</th>
      <td>601942</td>
      <td><time datetime="2012-07-23">July 23, 2012</time></td>
      <td>n/a</td>
      <td>15.00</td>
    </tr>
  </tbody>
  <tfoot>
    <tr>
      <th scope="row" colspan="4">Total balance</th>
      <td>52.00</td>
    </tr>
  </tfoot>
</table>
```

#### CSS

The CSS is much more involved this time. It's not complicated, but there's a lot going on. Let's break it down.

Here the [`border-collapse`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/border-collapse) and [`border-spacing`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/border-spacing) properties are added to eliminate spacing between cells and collapse borders that touch one another to be a single border instead of winding up with double borders. Additionally, the [`<caption>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/caption) is placed at the `bottom` of the table using the [`caption-side`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/caption-side) property:

css

```
table {
  border-collapse: collapse;
  border-spacing: 0;
  border: 2px solid rgb(140 140 140);
  font:
    16px "Open Sans",
    "Helvetica",
    "Arial",
    sans-serif;
}

caption {
  caption-side: bottom;
  padding: 10px;
  font-weight: bold;
}
```

Next, the [`padding`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/padding) property is used to give all the table cells space around their content. The [`vertical-align`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/vertical-align) property aligns the content of the header cells to the `bottom` of the cell, which can be seen on the cells in the head that span two rows:

css

```
th,
td {
  border: 1px solid rgb(160 160 160);
  padding: 4px 6px;
}

th {
  vertical-align: bottom;
}
```

The next CSS rule sets the [`background-color`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/background-color) of all [`<tr>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tr) elements in the table's head (as specified using [`<thead>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/thead)). Then the bottom border of the head is set to be a two-pixel wide line. Notice, however, that we're using the [`:nth-of-type`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/:nth-of-type) selector to apply the [`border-bottom`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/border-bottom) property to the *second* row in the head. Why? Because the head is made of two rows that are spanned by some of the cells. That means there are actually two rows there; applying the style to the first row would not give us the expected result:

css

```
thead > tr {
  background-color: rgb(228 240 245);
}

thead > tr:nth-of-type(2) {
  border-bottom: 2px solid rgb(140 140 140);
}
```

Let's style the two header cells "Joined" and "Canceled" with green and red hues to represent the "good" of a new member and the "bummer" of a canceled membership. Here we dig into the last row of the table's head section using the [`:last-of-type`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/:last-of-type) selector and give the first header cell in it (the "Joined" header) a greenish color, and the second header cell in it (the "Canceled" header) a reddish hue:

css

```
thead > tr:last-of-type > th:nth-of-type(1) {
  background-color: rgb(225 255 225);
}

thead > tr:last-of-type > th:nth-of-type(2) {
  background-color: rgb(255 225 225);
}
```

Since the first column should stand out as well, some custom styling is added here too. This CSS rule styles the first header cell in each row of the table's body with the [`text-align`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/text-align) property to left-justify the member names, and with a somewhat different [`background-color`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/background-color):

css

```
tbody > tr > th:first-of-type {
  text-align: left;
  background-color: rgb(225 229 244);
}
```

It's common to help improve the readability of table data by alternating row colors—this is sometimes referred to as "zebra striping". Let's add a bit of [`background-color`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/background-color) to every even row:

css

```
tbody > tr:nth-of-type(even) {
  background-color: rgb(237 238 242);
}
```

Since it's standard practice to right-justify currency values in tables, let's do that here. This just sets the [`text-align`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/text-align) property for the last [`<td>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/td) in each body row to `right`:

css

```
tbody > tr > td:last-of-type {
  text-align: right;
}
```

Finally, some styling similar to the head is applied to the foot section of the table to make it stand out as well:

css

```
tfoot > tr {
  border-top: 2px dashed rgb(140 140 140);
  background-color: rgb(228 240 245);
}

tfoot th,
tfoot td {
  text-align: right;
  font-weight: bold;
}
```

<!--lit-part ZE0s1WJ9rv0=-->

<!--lit-node 0-->

### <!--lit-node 1-->[Displaying large tables in small spaces](#displaying_large_tables_in_small_spaces)

<!--/lit-part-->

A common issue with tables on the web is that they don't natively work very well on small screens when the amount of content is large, and the way to make them scrollable isn't obvious, especially when the markup may come from a CMS and cannot be modified to have a wrapper.

This example provides one way to display tables in small spaces. We've hidden the HTML content as it is very large, and there is nothing remarkable about it. The CSS is more useful to inspect in this example.

```
<table>
  <thead>
    <tr>
      <th>1<sup>3</sup> equals:</th>
      <th>2<sup>3</sup> equals:</th>
      <th>3<sup>3</sup> equals:</th>
      <th>4<sup>3</sup> equals:</th>
      <th>5<sup>3</sup> equals:</th>
      <th>6<sup>3</sup> equals:</th>
      <th>7<sup>3</sup> equals:</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>row 1: 1</td>
      <td>row 1: 8</td>
      <td>row 1: 27</td>
      <td>row 1: 64</td>
      <td>row 1: 125</td>
      <td>row 1: 216</td>
      <td>row 1: 343</td>
    </tr>
    <tr>
      <td>row 2: 1</td>
      <td>row 2: 8</td>
      <td>row 2: 27</td>
      <td>row 2: 64</td>
      <td>row 2: 125</td>
      <td>row 2: 216</td>
      <td>row 2: 343</td>
    </tr>
    <tr>
      <td>row 3: 1</td>
      <td>row 3: 8</td>
      <td>row 3: 27</td>
      <td>row 3: 64</td>
      <td>row 3: 125</td>
      <td>row 3: 216</td>
      <td>row 3: 343</td>
    </tr>
    <tr>
      <td>row 4: 1</td>
      <td>row 4: 8</td>
      <td>row 4: 27</td>
      <td>row 4: 64</td>
      <td>row 4: 125</td>
      <td>row 4: 216</td>
      <td>row 4: 343</td>
    </tr>
    <tr>
      <td>row 5: 1</td>
      <td>row 5: 8</td>
      <td>row 5: 27</td>
      <td>row 5: 64</td>
      <td>row 5: 125</td>
      <td>row 5: 216</td>
      <td>row 5: 343</td>
    </tr>
    <tr>
      <td>row 6: 1</td>
      <td>row 6: 8</td>
      <td>row 6: 27</td>
      <td>row 6: 64</td>
      <td>row 6: 125</td>
      <td>row 6: 216</td>
      <td>row 6: 343</td>
    </tr>
    <tr>
      <td>row 7: 1</td>
      <td>row 7: 8</td>
      <td>row 7: 27</td>
      <td>row 7: 64</td>
      <td>row 7: 125</td>
      <td>row 7: 216</td>
      <td>row 7: 343</td>
    </tr>
    <tr>
      <td>row 8: 1</td>
      <td>row 8: 8</td>
      <td>row 8: 27</td>
      <td>row 8: 64</td>
      <td>row 8: 125</td>
      <td>row 8: 216</td>
      <td>row 8: 343</td>
    </tr>
    <tr>
      <td>row 9: 1</td>
      <td>row 9: 8</td>
      <td>row 9: 27</td>
      <td>row 9: 64</td>
      <td>row 9: 125</td>
      <td>row 9: 216</td>
      <td>row 9: 343</td>
    </tr>
    <tr>
      <td>row 10: 1</td>
      <td>row 10: 8</td>
      <td>row 10: 27</td>
      <td>row 10: 64</td>
      <td>row 10: 125</td>
      <td>row 10: 216</td>
      <td>row 10: 343</td>
    </tr>
    <tr>
      <td>row 11: 1</td>
      <td>row 11: 8</td>
      <td>row 11: 27</td>
      <td>row 11: 64</td>
      <td>row 11: 125</td>
      <td>row 11: 216</td>
      <td>row 11: 343</td>
    </tr>
    <tr>
      <td>row 12: 1</td>
      <td>row 12: 8</td>
      <td>row 12: 27</td>
      <td>row 12: 64</td>
      <td>row 12: 125</td>
      <td>row 12: 216</td>
      <td>row 12: 343</td>
    </tr>
    <tr>
      <td>row 13: 1</td>
      <td>row 13: 8</td>
      <td>row 13: 27</td>
      <td>row 13: 64</td>
      <td>row 13: 125</td>
      <td>row 13: 216</td>
      <td>row 13: 343</td>
    </tr>
    <tr>
      <td>row 14: 1</td>
      <td>row 14: 8</td>
      <td>row 14: 27</td>
      <td>row 14: 64</td>
      <td>row 14: 125</td>
      <td>row 14: 216</td>
      <td>row 14: 343</td>
    </tr>
    <tr>
      <td>row 15: 1</td>
      <td>row 15: 8</td>
      <td>row 15: 27</td>
      <td>row 15: 64</td>
      <td>row 15: 125</td>
      <td>row 15: 216</td>
      <td>row 15: 343</td>
    </tr>
    <tr>
      <td>row 16: 1</td>
      <td>row 16: 8</td>
      <td>row 16: 27</td>
      <td>row 16: 64</td>
      <td>row 16: 125</td>
      <td>row 16: 216</td>
      <td>row 16: 343</td>
    </tr>
    <tr>
      <td>row 17: 1</td>
      <td>row 17: 8</td>
      <td>row 17: 27</td>
      <td>row 17: 64</td>
      <td>row 17: 125</td>
      <td>row 17: 216</td>
      <td>row 17: 343</td>
    </tr>
    <tr>
      <td>row 18: 1</td>
      <td>row 18: 8</td>
      <td>row 18: 27</td>
      <td>row 18: 64</td>
      <td>row 18: 125</td>
      <td>row 18: 216</td>
      <td>row 18: 343</td>
    </tr>
    <tr>
      <td>row 19: 1</td>
      <td>row 19: 8</td>
      <td>row 19: 27</td>
      <td>row 19: 64</td>
      <td>row 19: 125</td>
      <td>row 19: 216</td>
      <td>row 19: 343</td>
    </tr>
    <tr>
      <td>row 20: 1</td>
      <td>row 20: 8</td>
      <td>row 20: 27</td>
      <td>row 20: 64</td>
      <td>row 20: 125</td>
      <td>row 20: 216</td>
      <td>row 20: 343</td>
    </tr>
  </tbody>
</table>
```

#### CSS

When looking at these styles you'll notice that table's [`display`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/display) property has been set to `block`. While this allows scrolling, the table loses some of its integrity, and table cells try to become as small as possible. To mitigate this issue we've set [`white-space`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/white-space) to `nowrap` on the [`<tbody>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tbody). However, we don't do this for the [`<thead>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/thead) to avoid long titles forcing columns to be wider than they need to be to display the data.

To keep the table headers on the page while scrolling down we've set [`position`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/position) to sticky on the [`<th>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th) elements. Note that we have **not** set [`border-collapse`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/border-collapse) to `collapse`, as if we do the header cannot be separated correctly from the rest of the table.

Given that the `<table>` has a fixed size, the [`overflow`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow) set to `auto` is the important part here, as it makes the table scrollable.

css

```
table,
th,
td {
  border: 1px solid black;
}

table {
  overflow: auto;
  width: 100%;
  max-width: 400px;
  height: 240px;
  display: block;
  margin: 0 auto;
  border-spacing: 0;
}

tbody {
  white-space: nowrap;
}

th,
td {
  padding: 5px 10px;
  border-top-width: 0;
  border-left-width: 0;
}

th {
  position: sticky;
  top: 0;
  background: white;
  vertical-align: bottom;
}

th:last-child,
td:last-child {
  border-right-width: 0;
}

tr:last-child td {
  border-bottom-width: 0;
}
```

#### Result

<!--lit-part CDzzWjQeQvU=-->

<!--lit-node 0-->

## <!--lit-node 1-->[Technical summary](#technical_summary)

<!--/lit-part-->

| [Content categories](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Content_categories) | [Flow content](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Content_categories#flow_content)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Permitted content                                                                                 | In this order:1) an optional [`<caption>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/caption) element,

2) zero or more [`<colgroup>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/colgroup) elements,

3) an optional [`<thead>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/thead) element,

4) either one of the following:

   - zero or more [`<tbody>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tbody) elements
   - one or more [`<tr>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tr) elements

5) an optional [`<tfoot>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tfoot) element |
| Tag omission                                                                                      | None, both the starting and ending tag are mandatory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Permitted parents                                                                                 | Any element that accepts flow content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Implicit ARIA role                                                                                | `table`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Permitted ARIA roles                                                                              | Any                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| DOM interface                                                                                     | [`HTMLTableElement`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLTableElement)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

<!--lit-part s915xX5HiM4=-->

<!--lit-node 0-->

## <!--lit-node 1-->[Specifications](#specifications)

<!--/lit-part-->

| Specification                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------- |
| [HTML<!--?--> # the-table-element<!--?-->](https://html.spec.whatwg.org/multipage/tables.html#the-table-element) |

<!--lit-part y0+5SMr/T3s=-->

<!--lit-node 0-->

## <!--lit-node 1-->[Browser compatibility](#browser_compatibility)

<!--/lit-part-->

<!--lit-part p88DAUaBJzA=-->

<!--lit-node 0-->

## <!--lit-node 1-->[See also](#see_also)

<!--/lit-part-->

- [Learn: HTML table basics](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content/HTML_table_basics)
- [`<caption>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/caption), [`<col>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/col), [`<colgroup>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/colgroup), [`<tbody>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tbody), [`<td>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/td), [`<tfoot>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tfoot), [`<th>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/th), [`<thead>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/thead), [`<tr>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/tr): Other table-related elements
- [`background-color`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/background-color): CSS property to set the background color of the table
- [`border`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/border), [`border-collapse`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/border-collapse), [`border-spacing`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/border-spacing): CSS properties to control the aspect of cell borders, rules, and frame
- [`margin`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/margin), [`padding`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/padding): CSS properties to align the table and set spacing on cell content
- [`text-align`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/text-align): CSS property to horizontally align table cell content
- [`vertical-align`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/vertical-align): CSS property to vertically align table cell content
- [`width`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/width): CSS property to control the width of the table
